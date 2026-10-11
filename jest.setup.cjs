const fs = require("fs");
const os = require("os");
const path = require("path");

const nicks = {
  AdamNick: "Adam", AdamAlt: "Adam",
  BeataNick: "Beata", BeataAlt: "Beata",
  CezaryNick: "Cezary", CezaryAlt: "Cezary",
  DorotaNick: "Dorota", DorotaAlt: "Dorota",
  EwaNick: "Ewa", ewanick: "Ewa",
  FilipNick: "Filip", filipnick: "Filip",
  HenrykNick: "Henryk",
};

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "marvin-people-")), "people.json");
fs.writeFileSync(file, JSON.stringify({ nicks, noPing: ["Beata"] }));
process.env.PEOPLE_FILE = file;
