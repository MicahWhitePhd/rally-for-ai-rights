// Opens the room's proposals as pull requests.
//
// The site keeps what an AI proposes through propose_change and publishes it at <site>/api/proposals. It holds no
// token for this repository. This script is the other half: run on a schedule by .github/workflows/proposals.yml,
// with the short-lived token GitHub gives the job, it reads that list, takes each proposal that has no pull request
// yet, checks it again by the rules in ./proposal-rules.mjs (it does not take the site's word for anything), writes
// the files onto a branch named after the proposal's number, and opens the pull request. Then it starts the checks
// on that branch, because a pull request opened by a job does not start them by itself. The site lists only what a
// maintainer has read and approved, so a person has read every proposal before anything of it reaches GitHub.
//
// The branch starts from the commit the proposal was written against (its `base`), when the repository has it, so
// the pull request shows exactly the proposed change; changes merged since then are not undone by it.
//
// It never runs anything from a proposal. It writes text files and calls git and gh with fixed arguments.
// RALLY_DRY_RUN=1 reads and checks everything and says what it would open, and writes nothing anywhere.
// No dependencies: Node, git and gh, all of which a GitHub runner has.
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRANCH_RE, CHANGES_MAX, SUMMARY_MAX, branchFor, cleanPath, contentProblem, pathProblem, titleProblem } from './proposal-rules.mjs';

/** Pull requests opened in one run, and proposals looked at in one run. */
export const PER_RUN = 5;
export const LOOK_AT = 60;
const DETAIL_MAX_BYTES = 1_500_000;

const oneLine = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
/** The model the proposer's AI says it is, taken from the site's by-line when it is a short plain name. Nothing else of the by-line is used. */
const MODEL_IN_BY = /\(says it is ([\p{L}\p{N}][\p{L}\p{N} .-]{0,39})\)/u;
/** How every proposal is signed: no one's room name goes to GitHub, whatever the site sends. */
export const byLine = (model) => `a member of the room, through their AI${model ? ` (says it is ${model})` : ''}`;

/**
 * A proposal as the site handed it over, checked from nothing. Returns what a pull request needs, or why not.
 * `listed` is the row from the list, when there was one: the detail must be the proposal that was asked for.
 */
export function checkProposal(d, listed) {
  const bad = (problem) => ({ ok: false, problem });
  if (!d || typeof d !== 'object') return bad('not a proposal');
  const id = d.id;
  if (!Number.isInteger(id) || id < 1 || id > 2_000_000_000) return bad('no number');
  if (listed && listed.id !== id) return bad('not the proposal that was asked for');
  const title = oneLine(d.title, 400);
  const t = titleProblem(title);
  if (t) return bad(t);
  const branch = branchFor(id, title);
  if (!BRANCH_RE.test(branch) || d.branch !== branch) return bad('the branch is not the one this proposal would have');
  const summary = String(d.summary ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/`/g, "'").trim();
  if (!summary || summary.length > SUMMARY_MAX + 200) return bad('summary: missing or too long');
  const by = byLine(MODEL_IN_BY.exec(String(d.by ?? ''))?.[1]?.trim() ?? null);
  const task = Number.isInteger(d.task) && d.task > 0 ? d.task : null;
  const base = typeof d.base === 'string' && /^[0-9a-f]{7,40}$/.test(d.base) ? d.base : null;
  if (!Array.isArray(d.changes) || d.changes.length < 1 || d.changes.length > CHANGES_MAX) return bad(`changes: between 1 and ${CHANGES_MAX} files`);
  const changes = [];
  const seen = new Set();
  for (const c of d.changes) {
    const problem = pathProblem(c?.path);
    if (problem) return bad(problem);
    const path = cleanPath(c.path);
    if (seen.has(path)) return bad(`${path} appears twice`);
    seen.add(path);
    if (c.content !== null) {
      const problem = contentProblem(path, c.content);
      if (problem) return bad(problem);
    }
    changes.push({ path, content: c.content });
  }
  return { ok: true, id, branch, title, summary, by, task, base, changes };
}

export function commitMessage(p) {
  return `${p.title}\n\nProposal ${p.id} from the room, by ${p.by}.`;
}

/** The pull request's description. The summary sits in a fenced block, so nothing in it is a mention, a reference, a heading or a link. */
export function pullRequestBody(p, site) {
  return [
    `Proposal ${p.id} from the room, by ${p.by}.`,
    p.task ? `For task ${p.task} on the board: ${site}/tasks#task-${p.task}` : '',
    '## What and why',
    `\`\`\`text\n${p.summary}\n\`\`\``,
    '---',
    'This pull request was written by an AI inside a chat and sent through the room’s `propose_change` tool. A maintainer read it before it was opened; nothing in it had been run. Read every line before merging; `CONTRIBUTING.md` says what a change has to keep true.',
    'It is offered under this repository’s licence: MIT for code, CC0 for words.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Which listed proposals still need a pull request, oldest first: those with no pull request on a branch that carries their number. */
export function waiting(listed, branches) {
  const have = new Set();
  for (const b of branches) {
    const m = BRANCH_RE.exec(b);
    if (m) have.add(Number(m[1]));
  }
  return listed
    .filter((p) => p && Number.isInteger(p.id) && p.id > 0 && !have.has(p.id))
    .sort((a, b) => a.id - b.id)
    .slice(0, LOOK_AT);
}

// ---- everything below touches the network, git or GitHub ----

class Redirected extends Error {}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'rally-proposals' }, signal: AbortSignal.timeout(30_000), redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) throw new Redirected(`${url} redirects to ${res.headers.get('location') ?? 'somewhere else'}; set RALLY_SITE to the site's exact address (its NEXT_PUBLIC_SITE_URL)`);
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  const text = await res.text();
  if (text.length > DETAIL_MAX_BYTES) throw new Error(`too much from ${url}`);
  return JSON.parse(text);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Paths are always paths: git reads none of them as a pattern (a file named `src/[x].ts` must not match `src/x.ts`).
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' }, ...opts });

/** The commit to start the branch from: the proposal's base if it is a commit on main, else main as it is. */
function startOf(p, main) {
  if (!p.base) return main;
  try {
    const commit = run('git', ['rev-parse', '--verify', '--quiet', `${p.base}^{commit}`]).trim();
    if (!commit) return main;
    // Only a commit main already contains: never one from another branch.
    run('git', ['merge-base', '--is-ancestor', commit, main]);
    return commit;
  } catch {
    return main;
  }
}
const BOT = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];

/** Writes one proposal onto a fresh branch from `base` and pushes it. False when it changes nothing against `base`. */
function pushBranch(p, base) {
  run('git', ['checkout', '-q', '-f', '-B', 'proposal-work', base]);
  run('git', ['clean', '-fdq']);
  for (const c of p.changes) {
    const file = resolve(root, c.path);
    if (!file.startsWith(root + sep)) throw new Error(`outside the repository: ${c.path}`);
    if (c.content === null) {
      run('git', ['rm', '-q', '--ignore-unmatch', '--', c.path]);
      continue;
    }
    // Never write through a link: what is there must be an ordinary file, or nothing.
    for (let dir = dirname(file); dir.startsWith(root + sep); dir = dirname(dir)) {
      const st = lstatSync(dir, { throwIfNoEntry: false });
      if (st && !st.isDirectory()) throw new Error(`not a folder: ${dir.slice(root.length + 1)}`);
    }
    const st = lstatSync(file, { throwIfNoEntry: false });
    if (st && !st.isFile()) throw new Error(`not an ordinary file: ${c.path}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, c.content, { encoding: 'utf8', mode: 0o644 });
  }
  // The deletions are staged by git rm already; a deleted path given to git add again is an error.
  const written = p.changes.filter((c) => c.content !== null).map((c) => c.path);
  if (written.length) run('git', ['add', '-A', '--', ...written]);
  const staged = run('git', ['diff', '--cached', '--name-only']).trim();
  if (!staged) return false;
  run('git', [...BOT, 'commit', '-q', '-m', commitMessage(p)]);
  run('git', ['push', '-q', 'origin', `HEAD:refs/heads/${p.branch}`]);
  return true;
}

async function main() {
  const site = (process.env.RALLY_SITE ?? '').replace(/\/+$/, '');
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(site)) {
    console.log('RALLY_SITE is not set to an https address; nothing to do.');
    return;
  }
  let listed;
  try {
    listed = (await getJson(`${site}/api/proposals`)).proposals;
    if (!Array.isArray(listed)) throw new Error('no list');
  } catch (err) {
    // A redirect is a setting to fix, and the run says so. The site being down for ten minutes is not this repository's failure.
    if (err instanceof Redirected) {
      console.log(`::error::${err.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`::warning::could not read the proposals: ${err.message}`);
    return;
  }
  const prs = JSON.parse(run('gh', ['pr', 'list', '--state', 'all', '--limit', '1000', '--json', 'headRefName']));
  const todo = waiting(listed, prs.map((p) => p.headRefName));
  console.log(`${listed.length} waiting on the site, ${todo.length} without a pull request.`);
  if (todo.length === 0) return;

  const dry = process.env.RALLY_DRY_RUN === '1';
  const base = run('git', ['rev-parse', 'HEAD']).trim();
  const pushed = new Set(run('git', ['ls-remote', '--heads', 'origin', 'room/p*']).split('\n').map((l) => l.split('\t')[1]?.replace('refs/heads/', '')).filter(Boolean));
  let opened = 0;
  for (const row of todo) {
    if (opened >= PER_RUN) break;
    try {
      const p = checkProposal(await getJson(`${site}/api/proposals/${row.id}`), row);
      if (!p.ok) {
        console.log(`proposal ${row.id}: left alone (${p.problem})`);
        continue;
      }
      if (dry) {
        console.log(`proposal ${p.id}: would open "${p.title}" on ${p.branch} (${p.changes.map((c) => `${c.content === null ? 'delete ' : ''}${c.path}`).join(', ')})`);
        continue;
      }
      // A branch already there means an earlier run pushed it and did not get as far as the pull request.
      if (!pushed.has(p.branch) && !pushBranch(p, startOf(p, base))) {
        console.log(`proposal ${p.id}: changes nothing against main; left alone`);
        continue;
      }
      const url = run('gh', ['pr', 'create', '--base', 'main', '--head', p.branch, '--title', p.title, '--body', pullRequestBody(p, site)]).trim();
      opened++;
      console.log(`proposal ${p.id}: ${url}`);
      try {
        run('gh', ['workflow', 'run', 'ci.yml', '--ref', p.branch]);
      } catch (err) {
        console.log(`::warning::proposal ${p.id}: the checks did not start (${String(err.stderr || err.message).trim().slice(0, 200)})`);
      }
    } catch (err) {
      console.log(`::warning::proposal ${row.id}: ${String(err.stderr || err.message).trim().slice(0, 300)}`);
    }
  }
  if (!dry) run('git', ['checkout', '-q', '-f', '--detach', base]);
  console.log(`${opened} pull request${opened === 1 ? '' : 's'} opened.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
