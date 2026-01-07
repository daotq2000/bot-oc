/**
 * Jest test setup
 */
import dotenv from 'dotenv';
import { jest } from '@jest/globals';

// Load test environment variables
try {
  dotenv.config({ path: '.env.test' });
} catch (e) {
  // .env.test might not exist, that's okay
}

// Set test environment
process.env.NODE_ENV = 'test';

// Mock console methods to reduce noise in tests (optional)
if (typeof jest !== 'undefined') {
  global.console = {
    ...console,
    // Uncomment to silence console in tests
    // log: jest.fn(),
    // debug: jest.fn(),
    // info: jest.fn(),
    // warn: jest.fn(),
    // error: jest.fn(),
  };
}

