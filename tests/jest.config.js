'use strict';

/**
 * jest.config.js
 *
 * modulePaths: tells Jest to also look in tests/node_modules when resolving
 * modules from the parent replica1/ and gateway/ directories.
 * This is required because axios is only installed in tests/node_modules,
 * not in replica1/node_modules (tests run outside Docker).
 */
module.exports = {
  testEnvironment: 'node',
  testMatch:       ['**/*.test.js'],
  verbose:         true,
  // Let modules required from ../replica1/ and ../gateway/ resolve through
  // the tests/ node_modules tree (so jest.mock('axios') works for them too)
  modulePaths: [
    '<rootDir>/node_modules',
  ],
  moduleDirectories: ['node_modules'],
  // Remap bare 'axios' to its CJS build so Jest (CommonJS mode) can load it.
  // axios@1.x ships index.js as ESM but provides a proper CJS bundle at
  // dist/node/axios.cjs — point there to avoid "Cannot use import statement" errors.
  moduleNameMapper: {
    '^axios$': '<rootDir>/node_modules/axios/dist/node/axios.cjs',
  },
};
