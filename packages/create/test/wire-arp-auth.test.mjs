import { test } from "node:test";
import assert from "node:assert/strict";
import { wireArpAuth } from "../dist/init.js";

test("wireArpAuth adds the import and puts arpAuth() first in extraAuth", () => {
  const src = `import { dispatchChannel } from "@kybernesis/dispatch";
import { kybernesisAuth } from "@kybernesis/enterprise";

export default dispatchChannel({
  governed: { issuer: "https://agent.kybernesis.ai", agent: "Kyber" },
  extraAuth: [
    kybernesisAuth({ issuer: "https://agent.kybernesis.ai", agent: "Kyber" }),
  ],
});
`;
  const out = wireArpAuth(src);
  assert.ok(out);
  assert.match(out, /^import \{ arpAuth \} from "@kybernesis\/identity";$/m);
  assert.match(out, /extraAuth: \[\n\s+\/\/ Deliveries[\s\S]*?\n\s+arpAuth\(\),\n\s+kybernesisAuth\(/);
  // Idempotent.
  assert.equal(wireArpAuth(out), out);
});

test("wireArpAuth handles eve's plain auth list and refuses a file with none", () => {
  const plain = `import { eveChannel } from "eve/channels/eve";\nimport { localDev } from "eve/channels/auth";\n\nexport default eveChannel({ auth: [localDev()] });\n`;
  const out = wireArpAuth(plain);
  assert.ok(out);
  assert.match(out, /auth: \[\n\s+\/\/ Deliveries[\s\S]*?arpAuth\(\),localDev\(\)\]/);
  assert.equal(wireArpAuth(`export default eveChannel({});\n`), null);
});
