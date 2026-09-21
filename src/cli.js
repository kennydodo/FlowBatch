#!/usr/bin/env node
import { parseArgs } from './lib/args.js';
import { buildContext } from './lib/context.js';
import { log, setColor, setLevel } from './lib/log.js';
import { loginCommand } from '../commands/login.js';
import { discoverCommand } from '../commands/discover.js';
import { doctorCommand } from '../commands/doctor.js';
import { generateCommand } from '../commands/generate.js';
import { serveCommand } from '../commands/serve.js';
import { repairCommand } from '../commands/repair.js';
import { upscaleCommand } from '../commands/upscale.js';

const COMMANDS = {
  login: {
    run: loginCommand,
    valueFlags: ['channel', 'slowmo', 'url'],
    summary: 'Open the persistent browser profile so you can sign in to Google Flow once.',
  },
  discover: {
    run: discoverCommand,
    valueFlags: ['wait', 'navigate', 'channel', 'slowmo', 'url', 'click', 'dump', 'agent', 'upload'],
    summary: 'Dump the Flow DOM (testids, buttons, file inputs) to calibrate config/selectors.json.',
  },
  doctor: {
    run: doctorCommand,
    valueFlags: ['channel', 'slowmo', 'url', 'project-url'],
    summary: 'Check the environment, config and (with --live) resolve every selector on the real page.',
  },
  generate: {
    run: generateCommand,
    valueFlags: ['job', 'only', 'limit', 'output', 'project-url', 'channel', 'slowmo', 'url'],
    summary: 'Run a batch job: many prompts x reference images -> generated images.',
  },
  serve: {
    run: serveCommand,
    valueFlags: ['port', 'host'],
    summary: 'Start the local web UI for running batches.',
  },
  repair: {
    run: repairCommand,
    valueFlags: ['job'],
    summary: 'Fix a job JSON in place: strip a UTF-8 BOM and repair mojibake text.',
  },
  upscale: {
    run: upscaleCommand,
    valueFlags: ['scale', 'model', 'out', 'set-scale'],
    summary: 'Upscale PNGs 1x/2x/3x/4x on the GPU (Real-ESRGAN), falling back to CPU.',
  },
};

const GLOBAL_VALUE_FLAGS = ['log-level'];

const HELP = `FlowImagesGen — Playwright batch image generator for Google Flow

Usage
  node src/cli.js <command> [options]
  npm run <command> -- [options]

Commands
  login      ${COMMANDS.login.summary}
  discover   ${COMMANDS.discover.summary}
  doctor     ${COMMANDS.doctor.summary}
  generate   ${COMMANDS.generate.summary}
  serve      ${COMMANDS.serve.summary}
  repair     ${COMMANDS.repair.summary}
  upscale    ${COMMANDS.upscale.summary}

login options
  --confirm             Wait for Enter before closing, so you can finish Google verification
  --keep-open           Leave the browser open when the run finishes

discover options
  --wait <seconds>      Seconds to let the page settle before dumping (default: 8)
  --navigate <url>      Navigate somewhere before dumping
  --click <selector>    Click a selector before dumping; repeatable, e.g. to open the Settings popover
  --dump <selector>     Save the outerHTML of matches to discover/; repeatable
  --agent <on|off>      Force the Agent mode toggle into a known state before dumping
  --upload <file>       Upload a reference image through the Add ingredients menu; repeatable
  --html                Also save the full page HTML

doctor options
  --live                Resolve every selector against the live page (needs a signed-in profile)
  --project-url <url>   Project to check against; prompt-box controls only exist inside a project

upscale options
  --scale <1|2|3|4>     Upscale factor; 1 is a pass-through (default: from config)
  --model <name>        realesr-animevideov3 | realesrgan-x4plus | realesrgan-x4plus-anime
  --out <dir>           Write results here instead of beside each input
  --set-scale <1|2|3|4> Remember this level as the default and exit
  --save                Also remember --scale / --model as the default
  With no arguments, prints the engine, device and current settings.

repair options
  --job <file>          Job JSON to repair (or pass it as the first argument)
  --dry-run             Show what would change without writing
  --no-backup           Skip the .bak copy

serve options
  --port <n>            Port to listen on (default: 8787)
  --host <addr>         Address to bind (default: 127.0.0.1)

Common options
  --log-level <debug|info|warn|error>   Console verbosity (default: info)
  --no-color                            Disable coloured output
  --channel <name>                      Browser channel, e.g. chrome or msedge
  --headless                            Run without a visible window (not recommended for login)
  --url <url>                           Override the Flow URL

generate options
  --job <file>          Job file to run (required)
  --output <dir>        Write results here instead of the job's outputsDir
  --project-url <url>   Override the job's projectUrl
  --only <id,id>        Run only these item ids
  --limit <n>           Run at most n items
  --no-resume           Re-run items already marked done in state/<job>.json
  --reset-state         Clear stored state before running
  --dry-run             Print the plan without launching a browser
  --repair-encoding     Fix mojibake (UTF-8 saved as CP1252) in prompts before sending
  --fail-fast           Stop at the first failed item
  --pause-on-error      Keep the browser open and wait for Enter after a failure
  --no-dump-on-error    Do not write debug/ screenshots + HTML on failure
  --keep-open           Leave the browser open when the run finishes

Web UI
  npm run ui
  then open http://127.0.0.1:8787

Typical first run
  npm run login
  npm run discover
  npm run doctor -- --live
  npm run generate -- --job config/jobs.example.json --dry-run
  npm run generate -- --job config/jobs.example.json
`;

async function main() {
  const argv = process.argv.slice(2);
  const commandName = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  const rest = commandName ? argv.slice(1) : argv;

  if (!commandName || commandName === 'help' || rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }

  const command = COMMANDS[commandName];
  if (!command) {
    log.error(`Unknown command "${commandName}". Available: ${Object.keys(COMMANDS).join(', ')}`);
    process.stdout.write(`\n${HELP}`);
    return 1;
  }

  const { flags, positionals } = parseArgs(rest, {
    valueFlags: [...command.valueFlags, ...GLOBAL_VALUE_FLAGS],
  });

  if (flags['log-level']) setLevel(flags['log-level']);
  if (flags.color === false) setColor(false);

  const context = buildContext(flags);
  return command.run({ flags, context, positionals });
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    log.error(String(error?.message ?? error));
    if (process.env.FLOW_IMAGES_GEN_DEBUG) log.debug(error?.stack ?? '');
    process.exitCode = 1;
  });
