import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defineConfig } from "@vscode/test-cli";

// The extension reads AWS profiles from ~/.aws. Tests get a throwaway home
// holding one fake profile, so they never see or use real credentials.
const testHome = path.resolve(".vscode-test", "home");
mkdirSync(path.join(testHome, ".aws"), { recursive: true });
writeFileSync(
  path.join(testHome, ".aws", "config"),
  "[profile local]\nregion = us-east-1\n",
);
writeFileSync(
  path.join(testHome, ".aws", "credentials"),
  "[local]\naws_access_key_id = local\naws_secret_access_key = local\n",
);

export default defineConfig({
  files: "out/test/**/*.test.js",
  env: {
    HOME: testHome,
    USERPROFILE: testHome,
    // Standard AWS SDK endpoint override. It starts on a closed local port so
    // nothing can reach AWS; the integration tests repoint it at the
    // in-process DynamoDB mock they start (src/test/integration).
    AWS_ENDPOINT_URL_DYNAMODB: "http://127.0.0.1:9",
    AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: undefined,
  },
});
