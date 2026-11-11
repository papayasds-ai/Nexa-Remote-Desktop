const fs = require("fs");
const crypto = require("crypto");

const source = fs.readFileSync("app/www/update-keys.js", "utf8");
const match = source.match(/window\.NEXA_UPDATE_KEYS\s*=\s*(\[[\s\S]*?\])/);

if (!match) throw new Error("Trusted keys not found");

const keys = JSON.parse(match[1]);
const data = fs.readFileSync("build/repo/ota/update.json");
const signature = Buffer.from(
  fs.readFileSync("build/repo/ota/update.sig2", "utf8").trim(),
  "base64"
);

keys.forEach((key, index) => {
  const der = Buffer.from(key.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const id = crypto.createHash("sha256").update(der).digest("hex").slice(0, 16);
  const valid = crypto.verify(
    "sha256",
    data,
    { key: der, format: "der", type: "spki" },
    signature
  );

  console.log("Key " + (index + 1) + " ID: " + id + " | Signature valid: " + valid);
});
