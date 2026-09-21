import { launchSession, closeSession } from '../src/browser/session.js';
import { FlowDriver } from '../src/flow/driver.js';
import { loadJob } from '../src/jobs/load.js';
import { RunState } from '../src/runner/state.js';
import { printPlan, runJob, selectItems } from '../src/runner/run.js';
import { intFlag, listFlag } from '../src/lib/args.js';
import { log } from '../src/lib/log.js';
import { fromRoot } from '../src/lib/paths.js';
import { pauseForEnter } from '../src/lib/prompt.js';

export async function generateCommand({ flags, context, positionals }) {
  const jobPath = typeof flags.job === 'string' ? flags.job : positionals[0];
  if (!jobPath) {
    throw new Error('Missing job file. Usage: npm run generate -- --job config/jobs.example.json');
  }

  const { settings } = context;
  const job = loadJob(jobPath, { settings, repairEncoding: flags['repair-encoding'] === true });

  // Let the caller redirect results without editing the job file.
  if (typeof flags.output === 'string' && flags.output.trim()) {
    job.outputsDir = fromRoot(flags.output.trim());
  }
  if (typeof flags['project-url'] === 'string' && flags['project-url'].trim()) {
    job.projectUrl = flags['project-url'].trim();
  }

  const options = {
    only: listFlag(flags, 'only'),
    limit: intFlag(flags, 'limit', 0),
    resume: flags.resume !== false,
    dryRun: flags['dry-run'] === true,
    failFast: flags['fail-fast'] === true,
    pauseOnError: flags['pause-on-error'] === true,
    dumpOnError: flags['dump-on-error'] !== false,
  };

  const state = RunState.open(RunState.pathFor(settings.dirs.stateDir, job.name), {
    jobName: job.name,
    jobPath: job.jobPath,
    items: job.items,
  });

  if (flags['reset-state'] === true) {
    state.reset(job.items.map((item) => item.id));
    state.save();
    log.info('State reset; every item will run again.');
  }

  if (options.dryRun) {
    const planned = selectItems(job.items, {
      only: options.only,
      limit: options.limit,
      resume: options.resume,
      state,
    });
    printPlan(job, planned, settings);
    log.info('Dry run complete; nothing was generated.');
    return 0;
  }

  const { context: browserContext, page } = await launchSession(settings);
  const driver = new FlowDriver({
    page,
    context: browserContext,
    selectors: context.selectors,
    settings,
  });

  try {
    const result = await runJob({ job, driver, state, settings, options });
    if (flags['keep-open'] === true) {
      await pauseForEnter('Browser left open (--keep-open).');
    }
    return result.failed > 0 ? 1 : 0;
  } finally {
    await closeSession(browserContext);
  }
}
