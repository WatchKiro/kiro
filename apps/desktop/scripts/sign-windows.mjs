// Signs a Windows binary (an .exe or .dll) for the release build. Tauri runs
// it for Kiro.exe, libmpv-2.dll, the uninstaller, the installer's plugins and
// the installer itself (`bundle.windows.signCommand`, set by
// scripts/build-windows.mjs when signing is configured).
//
// Two ways to sign, chosen from the environment:
//
// - Azure Artifact Signing (formerly Trusted Signing), through
//   `artifact-signing-cli` (`cargo install artifact-signing-cli`, which also
//   needs signtool and .NET): AZURE_ARTIFACT_SIGNING_ENDPOINT,
//   AZURE_ARTIFACT_SIGNING_ACCOUNT, AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE,
//   AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET.
// - A code signing certificate as a .pfx file, through signtool (Windows
//   SDK): WINDOWS_CERTIFICATE (the .pfx, base64-encoded) and
//   WINDOWS_CERTIFICATE_PASSWORD.
//
// Timestamps come from WINDOWS_TIMESTAMP_URL if set, otherwise the signing
// service's own (Azure) or DigiCert's (.pfx).
//
// Usage: node scripts/sign-windows.mjs <file>
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const AZURE_VARIABLES = [
  'AZURE_ARTIFACT_SIGNING_ENDPOINT',
  'AZURE_ARTIFACT_SIGNING_ACCOUNT',
  'AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
];
const PFX_VARIABLES = ['WINDOWS_CERTIFICATE', 'WINDOWS_CERTIFICATE_PASSWORD'];

/** `'azure'`, `'pfx'`, or `null` when nothing is configured (an unsigned build). */
export function signingMethod(env = process.env) {
  const has = (names) => names.every((name) => Boolean(env[name]));
  if (has(AZURE_VARIABLES)) return 'azure';
  if (has(PFX_VARIABLES)) return 'pfx';
  const partial = [...AZURE_VARIABLES, ...PFX_VARIABLES].filter((name) => env[name]);
  if (partial.length > 0) {
    throw new Error(
      `signing is only partly configured (${partial.join(', ')} set); ` +
        `set all of ${AZURE_VARIABLES.join(', ')} or all of ${PFX_VARIABLES.join(', ')}`,
    );
  }
  return null;
}

/** The newest x64 signtool.exe from an installed Windows SDK, or SIGNTOOL. */
function findSigntool() {
  if (process.env.SIGNTOOL) return process.env.SIGNTOOL;
  const kits = join(
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Windows Kits',
    '10',
    'bin',
  );
  const versions = existsSync(kits)
    ? readdirSync(kits)
        .filter((name) => /^10\.\d+\.\d+\.\d+$/.test(name))
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
        .reverse()
    : [];
  for (const version of versions) {
    const signtool = join(kits, version, 'x64', 'signtool.exe');
    if (existsSync(signtool)) return signtool;
  }
  throw new Error('signtool.exe not found: install the Windows SDK, or set SIGNTOOL');
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

export function sign(file) {
  const method = signingMethod();
  if (method === 'azure') {
    const args = ['-e', process.env.AZURE_ARTIFACT_SIGNING_ENDPOINT];
    if (process.env.WINDOWS_TIMESTAMP_URL) args.push('-t', process.env.WINDOWS_TIMESTAMP_URL);
    // The account, certificate profile and Azure credentials are read from
    // the environment.
    run('artifact-signing-cli', [...args, file]);
  } else if (method === 'pfx') {
    const pfx = join(tmpdir(), `kiro-signing-${randomUUID()}.pfx`);
    writeFileSync(pfx, Buffer.from(process.env.WINDOWS_CERTIFICATE, 'base64'), { mode: 0o600 });
    try {
      run(findSigntool(), [
        'sign',
        '/fd',
        'SHA256',
        '/f',
        pfx,
        '/p',
        process.env.WINDOWS_CERTIFICATE_PASSWORD,
        '/tr',
        process.env.WINDOWS_TIMESTAMP_URL || 'http://timestamp.digicert.com',
        '/td',
        'SHA256',
        '/d',
        'Kiro',
        file,
      ]);
    } finally {
      rmSync(pfx, { force: true });
    }
  } else {
    throw new Error('no signing credentials are set (see docs/releasing.md)');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/sign-windows.mjs <file>');
    process.exit(2);
  }
  try {
    sign(file);
  } catch (error) {
    console.error(`sign-windows: ${error.message}`);
    process.exit(1);
  }
}
