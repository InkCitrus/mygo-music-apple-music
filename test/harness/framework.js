/**
 * Opaque-Box E2E Testing Framework for MyGo Music Apple Music Plugin
 * Zero-dependency, lightweight, standalone test runner and assertion library.
 */

const suites = [];
let currentSuite = null;

export function describe(name, fn) {
  const suite = {
    name,
    tests: [],
    beforeEachHooks: [],
    afterEachHooks: [],
    beforeAllHooks: [],
    afterAllHooks: [],
  };
  suites.push(suite);
  currentSuite = suite;
  fn();
  currentSuite = null;
}

export function test(name, fn) {
  if (!currentSuite) {
    describe("Default Suite", () => {
      currentSuite.tests.push({ name, fn });
    });
  } else {
    currentSuite.tests.push({ name, fn });
  }
}

export const it = test;

export function beforeEach(fn) {
  if (currentSuite) currentSuite.beforeEachHooks.push(fn);
}

export function afterEach(fn) {
  if (currentSuite) currentSuite.afterEachHooks.push(fn);
}

export function beforeAll(fn) {
  if (currentSuite) currentSuite.beforeAllHooks.push(fn);
}

export function afterAll(fn) {
  if (currentSuite) currentSuite.afterAllHooks.push(fn);
}

// Assertions
export function assert(condition, message = "Assertion failed") {
  if (!condition) {
    throw new Error(message);
  }
}

export function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    const msg = message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    throw new Error(msg);
  }
}

export function assertDeepEquals(actual, expected, message) {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr !== expectedStr) {
    const msg = message || `Expected deep equality:\nExpected: ${expectedStr}\nActual:   ${actualStr}`;
    throw new Error(msg);
  }
}

export function assertTruthy(value, message = "Expected truthy value") {
  if (!value) {
    throw new Error(`${message}: got ${value}`);
  }
}

export function assertFalsy(value, message = "Expected falsy value") {
  if (value) {
    throw new Error(`${message}: got ${value}`);
  }
}

export function assertIncludes(haystack, needle, message) {
  if (typeof haystack === "string") {
    if (!haystack.includes(needle)) {
      throw new Error(message || `Expected string to include "${needle}", got "${haystack}"`);
    }
  } else if (Array.isArray(haystack)) {
    if (!haystack.includes(needle)) {
      throw new Error(message || `Expected array to include ${JSON.stringify(needle)}`);
    }
  } else {
    throw new Error(`assertIncludes requires string or array`);
  }
}

export async function assertRejects(asyncFn, expectedErrorCodeOrCheck, message) {
  let threw = false;
  let caughtError = null;
  try {
    await asyncFn();
  } catch (err) {
    threw = true;
    caughtError = err;
  }
  if (!threw) {
    throw new Error(message || "Expected async function to throw, but it succeeded");
  }
  if (typeof expectedErrorCodeOrCheck === "string") {
    if (caughtError.code !== expectedErrorCodeOrCheck && !caughtError.message.includes(expectedErrorCodeOrCheck)) {
      throw new Error(
        message ||
        `Expected error code/message "${expectedErrorCodeOrCheck}", got code="${caughtError.code}" message="${caughtError.message}"`
      );
    }
  } else if (typeof expectedErrorCodeOrCheck === "function") {
    expectedErrorCodeOrCheck(caughtError);
  }
}

export function assertThrows(fn, expectedErrorCodeOrCheck, message) {
  let threw = false;
  let caughtError = null;
  try {
    fn();
  } catch (err) {
    threw = true;
    caughtError = err;
  }
  if (!threw) {
    throw new Error(message || "Expected function to throw, but it succeeded");
  }
  if (typeof expectedErrorCodeOrCheck === "string") {
    if (caughtError.code !== expectedErrorCodeOrCheck && !caughtError.message.includes(expectedErrorCodeOrCheck)) {
      throw new Error(
        message ||
        `Expected error code/message "${expectedErrorCodeOrCheck}", got code="${caughtError.code}" message="${caughtError.message}"`
      );
    }
  } else if (typeof expectedErrorCodeOrCheck === "function") {
    expectedErrorCodeOrCheck(caughtError);
  }
}

// Suite Runner
export async function runSuites() {
  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;
  const failures = [];
  const startTime = Date.now();

  for (const suite of suites) {
    console.log(`\n\x1b[1m\x1b[36m▶ Suite: ${suite.name}\x1b[0m`);

    for (const hook of suite.beforeAllHooks) {
      await hook();
    }

    for (const testItem of suite.tests) {
      totalTests++;
      for (const hook of suite.beforeEachHooks) {
        await hook();
      }

      const testStart = Date.now();
      try {
        await testItem.fn();
        const duration = Date.now() - testStart;
        passedTests++;
        console.log(`  \x1b[32m✔\x1b[0m ${testItem.name} \x1b[90m(${duration}ms)\x1b[0m`);
      } catch (err) {
        const duration = Date.now() - testStart;
        failedTests++;
        console.log(`  \x1b[31m✖\x1b[0m ${testItem.name} \x1b[90m(${duration}ms)\x1b[0m`);
        console.log(`    \x1b[31m${err.message}\x1b[0m`);
        failures.push({
          suite: suite.name,
          test: testItem.name,
          error: err,
        });
      }

      for (const hook of suite.afterEachHooks) {
        await hook();
      }
    }

    for (const hook of suite.afterAllHooks) {
      await hook();
    }
  }

  const totalDuration = Date.now() - startTime;
  console.log(`\n\x1b[1m========================================\x1b[0m`);
  console.log(`\x1b[1mTest Run Summary\x1b[0m`);
  console.log(`Suites:  ${suites.length}`);
  console.log(`Total:   ${totalTests}`);
  console.log(`Passed:  \x1b[32m${passedTests}\x1b[0m`);
  console.log(`Failed:  ${failedTests > 0 ? `\x1b[31m${failedTests}\x1b[0m` : `\x1b[32m0\x1b[0m`}`);
  console.log(`Time:    ${totalDuration}ms`);
  console.log(`\x1b[1m========================================\x1b[0m\n`);

  if (failures.length > 0) {
    console.log(`\x1b[31m\x1b[1mFAILURES:\x1b[0m`);
    failures.forEach((f, idx) => {
      console.log(`\n${idx + 1}) [${f.suite}] ${f.test}`);
      console.log(f.error.stack || f.error.message);
    });
    return { success: false, total: totalTests, passed: passedTests, failed: failedTests, duration: totalDuration };
  }

  return { success: true, total: totalTests, passed: passedTests, failed: failedTests, duration: totalDuration };
}
