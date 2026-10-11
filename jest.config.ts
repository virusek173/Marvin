module.exports = {
  transform: {
    "\\.[jt]sx?$": "ts-jest",
  },
  moduleNameMapper: {
    "(.+)\\.js": "$1",
  },
  extensionsToTreatAsEsm: [".ts"],
  setupFiles: ["<rootDir>/jest.setup.cjs"],
  testPathIgnorePatterns: ["/node_modules/", "/dest/"],
};
