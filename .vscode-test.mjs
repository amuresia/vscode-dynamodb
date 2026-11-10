import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defineConfig } from "@vscode/test-cli";

// Tests run with a throwaway home holding one fake AWS profile, and with the
// DynamoDB endpoint on a closed local port until a test starts a local mock.
const awsDir = path.resolve(".vscode-test", "home", ".aws");
mkdirSync(awsDir, { recursive: true });
writeFileSync(path.join(awsDir, "config"), "[profile local]\n");
writeFileSync(
  path.join(awsDir, "credentials"),
  "[local]\naws_access_key_id = local\naws_secret_access_key = local\n",
);

export default defineConfig({
  files: "out/test/**/*.test.js",
  env: {
    HOME: path.dirname(awsDir),
    USERPROFILE: path.dirname(awsDir),
    AWS_ENDPOINT_URL_DYNAMODB: "http://127.0.0.1:9",
  },
});
