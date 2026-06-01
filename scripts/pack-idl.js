const fs = require("fs");
const path = require("path");
const idl = require("../target/idl/kage.json");
const out = path.join(__dirname, "..", "idl-pkg");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "kage.json"), JSON.stringify(idl, null, 2));
fs.writeFileSync(
  path.join(out, "index.js"),
  `module.exports = { idl: require("./kage.json"), address: ${JSON.stringify(idl.address)} };\n`
);
fs.writeFileSync(
  path.join(out, "package.json"),
  JSON.stringify({
    name: "@kagehq/program-idl",
    version: "1.0.0",
    main: "index.js",
    files: ["index.js", "kage.json"],
    publishConfig: { registry: "https://npm.pkg.github.com" },
    repository: { type: "git", url: "git+https://github.com/KageHQ/kage-program.git" },
  }, null, 2)
);
