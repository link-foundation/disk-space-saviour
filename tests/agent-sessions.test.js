/**
 * A Claude Code session keeps its scratchpad under
 * `<tmp>/claude-<uid>/<project>/<session id>`. What it builds there belongs
 * to its work until the session stays idle for the inactive window.
 */

import { describe, it, expect } from 'test-anywhere';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { blockedConditions } from '../src/conditions.js';
import { agentSessionOf } from '../src/liveness.js';
import { clean } from '../src/clean.js';
import { scan } from '../src/scan.js';
import {
  DAY_MS,
  age,
  fixtureEnv,
  removeRoot,
  scanInput,
  tempRoot,
  writePackage,
} from './helpers/fixtures.js';
import { itUnless, sandboxed } from './helpers/skip.js';

const SESSION = '077f596b-42a7-4024-81a6-f6699b771cbe';
const PROJECT = '-Users-me-Code-app';

/** A session scratchpad holding a Node project, everything 40 days old. */
function sessionFixture(root) {
  const session = join(root, 'tmp', 'claude-501', PROJECT, SESSION);
  const app = join(session, 'scratchpad', 'app');
  const modules = join(app, 'node_modules');
  writePackage(modules, 'dep');
  writeFileSync(join(app, 'package.json'), '{}');
  writeFileSync(join(app, 'package-lock.json'), '{}');
  const transcript = join(root, 'home', '.claude', 'projects', PROJECT);
  mkdirSync(transcript, { recursive: true });
  writeFileSync(join(transcript, `${SESSION}.jsonl`), '{}\n');
  age(root, 40 * DAY_MS);
  return { modules, transcript: join(transcript, `${SESSION}.jsonl`) };
}

async function scanModules(root, modules) {
  const env = fixtureEnv(root);
  const report = await scan(
    scanInput(env, [join(root, 'tmp')], { scanners: ['projects'] })
  );
  return {
    env,
    report,
    item: report.items.find((entry) => entry.path === modules),
  };
}

describe('Claude Code session scratchpads', () => {
  it('finds the session a path lies in', () => {
    expect(
      agentSessionOf(
        `/private/tmp/claude-501/${PROJECT}/${SESSION}/scratchpad/app/node_modules`,
        posix
      )
    ).toEqual({
      dir: `/private/tmp/claude-501/${PROJECT}/${SESSION}`,
      project: PROJECT,
      id: SESSION,
    });
    expect(agentSessionOf(`/tmp/claude-501/${PROJECT}`, posix)).toBe(null);
    expect(agentSessionOf('/work/claude-501/app/node_modules', posix)).toBe(
      null
    );
  });

  itUnless(sandboxed)(
    'keeps what a session built while its transcript is recent',
    async () => {
      const root = tempRoot('dss-agent-session-');
      try {
        const { modules, transcript } = sessionFixture(root);
        writeFileSync(transcript, '{}\n{}\n');
        const { report, item } = await scanModules(root, modules);
        expect(item.blockers.length > 0).toBe(true);
        expect(item.blockers.join('\n')).toMatch(
          /inside the scratchpad of Claude Code session 077f596b \(active .+ ago\); kept until it is idle for 30d/
        );
        const { conditions } = blockedConditions(
          report.items.filter((entry) => entry.blockers.length > 0)
        );
        expect(conditions.map((condition) => condition.action)).toEqual([
          'the Claude Code session 077f596b stays idle for 30d',
        ]);
      } finally {
        removeRoot(root);
      }
    }
  );

  itUnless(sandboxed)(
    'rechecks the session right before deletion',
    async () => {
      const root = tempRoot('dss-agent-session-');
      try {
        const { modules, transcript } = sessionFixture(root);
        const { env, report, item } = await scanModules(root, modules);
        expect(item.blockers).toEqual([]);
        writeFileSync(transcript, '{}\n{}\n');
        const audit = await clean(report, {
          env,
          tier: 'safe',
          audit: false,
        });
        expect(audit.entries[0].status).toBe('skipped');
        expect(audit.entries[0].reason).toMatch(/Claude Code session 077f596b/);
        expect(existsSync(modules)).toBe(true);
      } finally {
        removeRoot(root);
      }
    }
  );
});
