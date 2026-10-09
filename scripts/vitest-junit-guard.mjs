import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export const HEARTBEAT_WINDOWS_OWNERSHIP_REPAIR_SUITE =
  "server/src/__tests__/heartbeat-windows-ownership-repair.test.ts";

const guardedSuites = new Map([
  [
    HEARTBEAT_WINDOWS_OWNERSHIP_REPAIR_SUITE,
    {
      suiteName: HEARTBEAT_WINDOWS_OWNERSHIP_REPAIR_SUITE,
      minimumTests: 9,
    },
  ],
]);

const require = createRequire(import.meta.url);

function parseXmlDocument(xml) {
  // Lane discovery runs before dependency installation. Only real JUnit
  // verification loads the parser; a missing dependency still fails closed.
  const { SaxesParser } = require("saxes");
  const parser = new SaxesParser({ xmlns: false, fragment: false });
  const roots = [];
  const stack = [];

  parser.on("error", (error) => {
    throw new Error(`Malformed JUnit XML: ${error.message}`, { cause: error });
  });
  parser.on("doctype", () => {
    throw new Error("Malformed JUnit XML: document type declarations are not supported.");
  });
  parser.on("opentag", ({ name, attributes }) => {
    const node = { name, attributes: new Map(Object.entries(attributes)), children: [] };
    if (stack.length > 0) stack.at(-1).children.push(node);
    else roots.push(node);
    stack.push(node);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.write(xml).close();
  return roots[0];
}

function parseCount(attributes, name, suiteName) {
  const raw = attributes.get(name);
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new Error(`JUnit suite ${suiteName} has no valid integer ${name} attribute.`);
  }
  return Number(raw);
}

function descendants(node, elementName) {
  const found = [];
  for (const child of node.children) {
    if (child.name === elementName) found.push(child);
    found.push(...descendants(child, elementName));
  }
  return found;
}

export function requiredJUnitGuardForSuite(repoPath) {
  const guard = guardedSuites.get(repoPath);
  return guard ? { ...guard } : null;
}

export function verifyVitestJUnitReport(xml, { suiteName, minimumTests }) {
  if (!Number.isInteger(minimumTests) || minimumTests < 1) {
    throw new Error(`minimumTests must be a positive integer. Received ${minimumTests}.`);
  }

  const root = parseXmlDocument(xml);
  const suites = [root, ...descendants(root, "testsuite")]
    .filter((node) => node.name === "testsuite");
  const matchingSuites = suites.filter((suite) => suite.attributes.get("name") === suiteName);

  if (matchingSuites.length !== 1) {
    throw new Error(
      `JUnit report must contain exactly one suite named ${suiteName}; found ${matchingSuites.length}.`,
    );
  }

  const [{ attributes, children }] = matchingSuites;
  const counts = {
    tests: parseCount(attributes, "tests", suiteName),
    failures: parseCount(attributes, "failures", suiteName),
    errors: parseCount(attributes, "errors", suiteName),
    skipped: parseCount(attributes, "skipped", suiteName),
  };
  const suiteNode = { children };
  const observed = {
    tests: descendants(suiteNode, "testcase").length,
    failures: descendants(suiteNode, "failure").length,
    errors: descendants(suiteNode, "error").length,
    skipped: descendants(suiteNode, "skipped").length,
  };

  for (const name of Object.keys(counts)) {
    if (counts[name] !== observed[name]) {
      throw new Error(
        `JUnit suite ${suiteName} has inconsistent ${name}: attribute=${counts[name]} elements=${observed[name]}.`,
      );
    }
  }

  if (counts.tests < minimumTests || counts.failures > 0 || counts.errors > 0 || counts.skipped > 0) {
    throw new Error(
      `JUnit suite ${suiteName} must run at least ${minimumTests} passing tests ` +
        `(tests=${counts.tests} failures=${counts.failures} errors=${counts.errors} skipped=${counts.skipped}).`,
    );
  }

  return counts;
}

export function verifyVitestJUnitFile(reportFile, guard) {
  return verifyVitestJUnitReport(readFileSync(reportFile, "utf8"), guard);
}
