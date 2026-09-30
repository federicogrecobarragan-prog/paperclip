import { readFileSync } from "node:fs";

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

const xmlNamePattern = /^[A-Za-z_:][A-Za-z0-9_.:-]*/;

function assertValidEntities(value) {
  const withoutEntities = value.replace(/&(?:amp|lt|gt|apos|quot|#\d+|#x[0-9A-Fa-f]+);/g, "");
  if (withoutEntities.includes("&")) {
    throw new Error("Malformed JUnit XML: invalid entity reference.");
  }
}

function parseStartTag(rawTag) {
  let source = rawTag;
  let selfClosing = false;
  if (/\/\s*$/.test(source)) {
    selfClosing = true;
    source = source.replace(/\/\s*$/, "");
  }

  const nameMatch = source.match(xmlNamePattern);
  if (!nameMatch) throw new Error("Malformed JUnit XML: invalid element name.");
  const name = nameMatch[0];
  const attributes = new Map();
  let offset = name.length;

  while (offset < source.length) {
    const whitespace = source.slice(offset).match(/^\s+/);
    if (!whitespace) throw new Error(`Malformed JUnit XML: invalid attributes on ${name}.`);
    offset += whitespace[0].length;
    if (offset >= source.length) break;

    const attributeNameMatch = source.slice(offset).match(xmlNamePattern);
    if (!attributeNameMatch) throw new Error(`Malformed JUnit XML: invalid attribute on ${name}.`);
    const attributeName = attributeNameMatch[0];
    if (attributes.has(attributeName)) {
      throw new Error(`Malformed JUnit XML: duplicate ${attributeName} attribute on ${name}.`);
    }
    offset += attributeName.length;
    const equalsMatch = source.slice(offset).match(/^\s*=\s*/);
    if (!equalsMatch) throw new Error(`Malformed JUnit XML: missing value for ${attributeName}.`);
    offset += equalsMatch[0].length;

    const quote = source[offset];
    if (quote !== '"' && quote !== "'") {
      throw new Error(`Malformed JUnit XML: unquoted ${attributeName} attribute.`);
    }
    const valueEnd = source.indexOf(quote, offset + 1);
    if (valueEnd < 0) throw new Error(`Malformed JUnit XML: unterminated ${attributeName} attribute.`);
    const value = source.slice(offset + 1, valueEnd);
    if (value.includes("<")) throw new Error(`Malformed JUnit XML: invalid ${attributeName} value.`);
    assertValidEntities(value);
    attributes.set(attributeName, value);
    offset = valueEnd + 1;
  }

  return { name, attributes, selfClosing };
}

function findTagEnd(xml, start) {
  let quote = null;
  for (let index = start; index < xml.length; index += 1) {
    const char = xml[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ">") return index;
    else if (char === "<") throw new Error("Malformed JUnit XML: nested tag opener.");
  }
  throw new Error("Malformed JUnit XML: unterminated tag.");
}

function parseXmlDocument(rawXml) {
  const xml = rawXml.replace(/^\uFEFF/, "");
  const roots = [];
  const stack = [];
  let offset = 0;

  while (offset < xml.length) {
    const tagStart = xml.indexOf("<", offset);
    const text = xml.slice(offset, tagStart < 0 ? xml.length : tagStart);
    assertValidEntities(text);
    if (stack.length === 0 && text.trim()) {
      throw new Error("Malformed JUnit XML: text outside the root element.");
    }
    if (tagStart < 0) break;

    if (xml.startsWith("<!--", tagStart)) {
      const end = xml.indexOf("-->", tagStart + 4);
      if (end < 0 || xml.slice(tagStart + 4, end).includes("--")) {
        throw new Error("Malformed JUnit XML: invalid comment.");
      }
      offset = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", tagStart)) {
      if (stack.length === 0) throw new Error("Malformed JUnit XML: CDATA outside the root element.");
      const end = xml.indexOf("]]>", tagStart + 9);
      if (end < 0) throw new Error("Malformed JUnit XML: unterminated CDATA.");
      offset = end + 3;
      continue;
    }
    if (xml.startsWith("<?", tagStart)) {
      const end = xml.indexOf("?>", tagStart + 2);
      if (end < 0) throw new Error("Malformed JUnit XML: unterminated processing instruction.");
      offset = end + 2;
      continue;
    }
    if (xml.startsWith("<!", tagStart)) {
      throw new Error("Malformed JUnit XML: unsupported declaration.");
    }

    const tagEnd = findTagEnd(xml, tagStart + 1);
    const rawTag = xml.slice(tagStart + 1, tagEnd);
    if (rawTag.startsWith("/")) {
      const closeMatch = rawTag.match(/^\/\s*([A-Za-z_:][A-Za-z0-9_.:-]*)\s*$/);
      if (!closeMatch) throw new Error("Malformed JUnit XML: invalid closing tag.");
      const current = stack.pop();
      if (!current || current.name !== closeMatch[1]) {
        throw new Error(`Malformed JUnit XML: unexpected closing tag ${closeMatch[1]}.`);
      }
    } else {
      const parsed = parseStartTag(rawTag);
      const node = { name: parsed.name, attributes: parsed.attributes, children: [] };
      if (stack.length > 0) stack.at(-1).children.push(node);
      else roots.push(node);
      if (!parsed.selfClosing) stack.push(node);
    }
    offset = tagEnd + 1;
  }

  if (stack.length > 0) throw new Error(`Malformed JUnit XML: unclosed ${stack.at(-1).name} element.`);
  if (roots.length !== 1) throw new Error(`Malformed JUnit XML: expected one root element; found ${roots.length}.`);
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
