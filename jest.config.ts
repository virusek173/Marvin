module.exports = {
  transform: {
    "\\.[jt]sx?$": "ts-jest",
  },
  moduleNameMapper: {
    "(.+)\\.js": "$1",
  },
  extensionsToTreatAsEsm: [".ts"],
  testPathIgnorePatterns: ["/node_modules/", "/dest/"],
};
