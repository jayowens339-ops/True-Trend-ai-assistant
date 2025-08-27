// scripts/setup-google-verify.js
// Usage:
//   node scripts/setup-google-verify.js googleXXXXXXXXXXXXXXX
//
// What it does:
// 1) Writes /public/googleTOKEN.html with the exact required content
// 2) Adds <meta name="google-site-verification" content="TOKEN"> to:
//    - Next.js App Router: app/head.tsx (or creates it)
//    - Next.js Pages Router: pages/_document.tsx (or creates it)
//    - Static site: public/index.html (patches if present)

const fs = require("fs");
const path = require("path");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeFileIfChanged(filePath, content) {
  if (fs.existsSync(filePath)) {
    const cur = fs.readFileSync(filePath, "utf8");
    if (cur.includes(content.trim())) return false;
  }
  fs.writeFileSync(filePath, content);
  return true;
}

function insertLineIfMissing(filePath, needle, lineToInsert) {
  let text = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  if (!text.includes(needle)) {
    // Very simple inject just before closing </head> or end of file
    if (text.includes("</head>")) {
      text = text.replace("</head>", `  ${lineToInsert}\n</head>`);
    } else {
      text += `\n${lineToInsert}\n`;
    }
    fs.writeFileSync(filePath, text);
    return true;
  }
  return false;
}

function createOrPatchAppHead(appDir, token) {
  const tsx = path.join(appDir, "head.tsx");
  const js = path.join(appDir, "head.js");
  const meta = `<meta name="google-site-verification" content="${token}" />`;

  const boilerplate = `export default function Head() {
  return (
    <>
      ${meta}
    </>
  );
}
`;

  if (fs.existsSync(tsx)) {
    const changed = insertLineIfMissing(tsx, `content="${token}"`, meta);
    return { file: tsx, created: false, changed };
  }
  if (fs.existsSync(js)) {
    const changed = insertLineIfMissing(js, `content="${token}"`, meta);
    return { file: js, created: false, changed };
  }
  fs.writeFileSync(tsx, boilerplate);
  return { file: tsx, created: true, changed: true };
}

function createOrPatchPagesDocument(pagesDir, token) {
  const tsx = path.join(pagesDir, "_document.tsx");
  const js  = path.join(pagesDir, "_document.js");
  const meta = `<meta name="google-site-verification" content="${token}" />`;

  const boilerplateTSX = `import Document, { Html, Head, Main, NextScript } from 'next/document';

export default class MyDocument extends Document {
  render() {
    return (
      <Html>
        <Head>
          ${meta}
        </Head>
        <body>
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}
`;

  const boilerplateJS = boilerplateTSX.replace(`from 'next/document'`, `from "next/document"`);

  if (fs.existsSync(tsx)) {
    const changed = insertLineIfMissing(tsx, `content="${token}"`, meta);
    return { file: tsx, created: false, changed };
  }
  if (fs.existsSync(js)) {
    const changed = insertLineIfMissing(js, `content="${token}"`, meta);
    return { file: js, created: false, changed };
  }
  // Prefer TSX by default
  fs.writeFileSync(tsx, boilerplateTSX);
  return { file: tsx, created: true, changed: true };
}

function patchStaticIndex(publicDir, token) {
  const idx = path.join(publicDir, "index.html");
  const meta = `<meta name="google-site-verification" content="${token}" />`;
  if (!fs.existsSync(idx)) {
    // Create a minimal index if none exists (static sites only)
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    ${meta}
    <title>Site Verification</title>
  </head>
  <body>
    <p>Google site verification placeholder.</p>
  </body>
</html>`;
    fs.writeFileSync(idx, html);
    return { file: idx, created: true, changed: true };
  } else {
    const changed = insertLineIfMissing(idx, `content="${token}"`, meta);
    return { file: idx, created: false, changed };
  }
}

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error("Usage: node scripts/setup-google-verify.js googleXXXXXXXXXXXXXXX[.html]");
    process.exit(1);
  }

  const token = raw.replace(/\.html$/i, "");
  const htmlName = `${token}.html`;
  const projectRoot = process.cwd();

  // 1) Create /public/googleTOKEN.html
  const publicDir = path.join(projectRoot, "public");
  ensureDir(publicDir);
  const verifyFilePath = path.join(publicDir, htmlName);
  const verifyContent = `google-site-verification: ${htmlName}\n`;
  writeFileIfChanged(verifyFilePath, verifyContent);

  // 2) Add meta tag (Next.js App Router or Pages Router or Static)
  const appDir = path.join(projectRoot, "app");
  const pagesDir = path.join(projectRoot, "pages");

  let result;
  if (fs.existsSync(appDir)) {
    result = createOrPatchAppHead(appDir, token);
  } else if (fs.existsSync(pagesDir)) {
    result = createOrPatchPagesDocument(pagesDir, token);
  } else {
    result = patchStaticIndex(publicDir, token);
  }

  console.log("✅ Google verification HTML:", verifyFilePath);
  console.log("✅ Meta injection:", result.file, result.created ? "(created)" : result.changed ? "(patched)" : "(already present)");
  console.log("\nNow deploy, then verify this URL in Search Console:");
  console.log(`https://YOUR-APP.vercel.app/${htmlName}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
