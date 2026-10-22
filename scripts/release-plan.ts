// qsh conventional commits, skip markers and manual release inputs. This only
// plans a candidate; publication remains gated on every required check.
import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
export function bumpKind(messages: string): 'major' | 'minor' | 'patch' | null {
  if (/^[A-Za-z]+(?:\([^)]+\))?!:|^BREAKING[ -]CHANGE:/m.test(messages)) return 'major';
  if (/^feat(?:\([^)]+\))?:/m.test(messages)) return 'minor';
  if (/^(fix|perf)(?:\([^)]+\))?:/m.test(messages)) return 'patch';
  return null;
}
interface ReleaseContext {
  current: string;
  env: Record<string, string | undefined>;
  head: string;
  tags: string[];
  messages: string;
}
// Release policy is pure; the CLI below is the Git/filesystem adapter.
export function plan({ current, env, head, tags, messages }: ReleaseContext) {
  const ref = env.GITHUB_REF || '',
    event = env.GITHUB_EVENT_NAME || '';
  const result = (version = current, release = false, commit = false) => ({
    version,
    release,
    commit,
  });
  if (ref.startsWith('refs/tags/v')) {
    if (ref.slice(11) !== current)
      throw new Error('Tag must match committed application and extension versions');
    return result(current, true);
  }
  const manual = event === 'workflow_dispatch' && env.INPUT_RELEASE === 'true';
  if (!(
    manual ||
    (event === 'push' &&
      ref === `refs/heads/${env.DEFAULT_BRANCH || 'main'}` &&
      !head.startsWith('chore: release v') &&
      !head.includes('[skip release]'))
  ))
    return result();
  if (!ref.startsWith('refs/heads/')) throw new Error('Manual releases must run from a branch');
  const kind = (env.INPUT_BUMP || 'auto') === 'auto' ? bumpKind(messages) : env.INPUT_BUMP;
  const explicit = env.INPUT_VERSION?.replace(/^v/, '');
  if (!explicit && !kind) return result();
  let [major, minor, patch] = current.split('.').map(Number) as [number, number, number];
  let version = explicit;
  if (!version) {
    if (kind === 'major') {
      major++;
      minor = patch = 0;
    } else if (kind === 'minor') {
      minor++;
      patch = 0;
    } else if (kind === 'patch') patch++;
    else throw new Error(`Unknown bump: ${kind}`);
    version = `${major}.${minor}.${patch}`;
  }
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
    version.split('.').some((n) => Number(n) > 65535) ||
    version === '0.0.0'
  )
    throw new Error('Release version must be a Chromium-compatible MAJOR.MINOR.PATCH');
  const before = current.split('.').map(Number),
    after = version.split('.').map(Number);
  const first = after.findIndex((n, i) => n !== before[i]);
  if (first < 0 || after[first]! < before[first]!) throw new Error('Release version must increase');
  if (tags.includes(`v${version}`)) throw new Error('Release tag already exists');
  return result(version, true, true);
}
if (import.meta.main) {
  const current = (
    Bun.TOML.parse(await Bun.file('Cargo.toml').text()) as { package: { version: string } }
  ).package.version;
  const tags = git('tag', '--list', 'v*', '--sort=-version:refname').split('\n').filter(Boolean);
  const output =
    Object.entries(
      plan({
        current,
        env: process.env,
        tags,
        head: git('log', '-1', '--format=%B'),
        messages: git('log', '--format=%B', tags[0] ? `${tags[0]}..HEAD` : 'HEAD'),
      }),
    )
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n';
  process.stdout.write(output);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, output);
}
