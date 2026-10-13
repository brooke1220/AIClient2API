export default {
  testEnvironment: 'node',
  transform: {
    '^.+\\.(js|mjs)$': ['babel-jest', {
      babelrc: false,
      presets: ['@babel/preset-env'],
      plugins: ['babel-plugin-transform-import-meta'],
    }],
  },
  transformIgnorePatterns: [
    '/node_modules/(?!\\.pnpm/|(?:uuid|proxy-chain|socks-proxy-agent|agent-base)/)', // Transform ESM proxy dependencies, including pnpm's nested layout.
  ],
  globals: {
    'jest': {
      useESM: true
    }
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  testMatch: [
    '**/tests/**/*.test.js'
  ],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/*.test.js',
    '!**/node_modules/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  testTimeout: 30000 // Add a global test timeout
};
