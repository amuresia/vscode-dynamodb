import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  CreateTableCommand,
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import dynalite from "dynalite";

import type { ConnectionSelection, KeyMetadata } from "../../types";

const ENDPOINT_ENV = "AWS_ENDPOINT_URL_DYNAMODB";

// Matches the fake profile that .vscode-test.mjs writes into the test home.
export const LOCAL_CONNECTION: ConnectionSelection = {
  profile: "local",
  region: "us-east-1",
};

export type RawItem = Record<string, AttributeValue>;

// An in-memory DynamoDB (dynalite) on a random local port. While it runs,
// every DynamoDB client in this process, including the ones the extension
// creates, is pointed at it through the AWS SDK's endpoint environment
// variable.
export class LocalDynamo {
  public static async start(): Promise<LocalDynamo> {
    const server = dynalite({ createTableMs: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    return new LocalDynamo(server);
  }

  private readonly previousEndpoint = process.env[ENDPOINT_ENV];
  private readonly client: DynamoDBClient;
  private readonly operations: string[] = [];

  private constructor(private readonly server: Server) {
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env[ENDPOINT_ENV] = endpoint;

    server.on("request", (request) => {
      const target = request.headers["x-amz-target"];
      this.operations.push(String(target).split(".").pop() ?? "");
    });

    this.client = new DynamoDBClient({
      endpoint,
      region: LOCAL_CONNECTION.region,
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });
  }

  public async stop(): Promise<void> {
    if (this.previousEndpoint === undefined) {
      delete process.env[ENDPOINT_ENV];
    } else {
      process.env[ENDPOINT_ENV] = this.previousEndpoint;
    }

    this.client.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // Number of requests of one operation (e.g. "DeleteItem") received so far.
  public countOperations(operation: string): number {
    return this.operations.filter((name) => name === operation).length;
  }

  public async createTable(
    tableName: string,
    partitionKey: KeyMetadata,
    sortKey?: KeyMetadata,
  ): Promise<void> {
    const keys = sortKey ? [partitionKey, sortKey] : [partitionKey];

    await this.client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: keys.map((key) => ({
          AttributeName: key.name,
          AttributeType: key.type,
        })),
        KeySchema: keys.map((key, index) => ({
          AttributeName: key.name,
          KeyType: index === 0 ? "HASH" : "RANGE",
        })),
      }),
    );
  }

  public async putItems(tableName: string, items: RawItem[]): Promise<void> {
    for (const item of items) {
      await this.client.send(
        new PutItemCommand({ TableName: tableName, Item: item }),
      );
    }
  }

  public async readItems(tableName: string): Promise<RawItem[]> {
    const response = await this.client.send(
      new ScanCommand({ TableName: tableName }),
    );

    return response.Items ?? [];
  }
}

// Canonical form of raw items for order-independent comparison.
export function canonicalItems(items: RawItem[]): string[] {
  return items
    .map((item) =>
      JSON.stringify(
        Object.entries(item).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    )
    .sort();
}
