/**
 * Tiny, dependency-free `{{variable}}` template engine for cluster command
 * templates, plus the helpers that build the remote `job.sh` and pull a job id
 * out of a submit command's stdout. Pure and unit-tested — no I/O here.
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g

/**
 * Substitute `{{name}}` placeholders from `vars`. A name present in `vars`
 * (even as an empty string) is treated as provided; a name absent entirely is
 * reported in `missing` and rendered as the empty string.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string | undefined>
): { text: string; missing: string[] } {
  const missing = new Set<string>()
  const text = template.replace(PLACEHOLDER, (_m, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name) && vars[name] != null) {
      return String(vars[name])
    }
    missing.add(name)
    return ''
  })
  return { text, missing: [...missing] }
}

/** Distinct variable names referenced by a template (for the config UI). */
export function templateVars(template: string): string[] {
  const set = new Set<string>()
  for (const m of template.matchAll(PLACEHOLDER)) set.add(m[1])
  return [...set]
}

/**
 * Build the remote `job.sh` FFE writes into the working directory. It is fully
 * rendered here (no placeholders left): cd into the workdir, run the setup
 * lines, run the Tinker command, then record the exit code so a background
 * (non-scheduler) run can report success/failure.
 *
 * `setup` typically prepends the remote Tinker bin dir to PATH and runs any
 * module-load lines; `tinkerCmd` is the bare Tinker invocation (e.g.
 * `dynamic mol.xyz 10000 1.0 1.0 2 298`).
 */
export function buildJobScript(opts: {
  workdir: string
  setup?: string
  tinkerCmd: string
}): string {
  const setup = (opts.setup ?? '').trim()
  return [
    '#!/bin/sh',
    `cd "${opts.workdir}" || exit 1`,
    ...(setup ? [setup] : []),
    opts.tinkerCmd,
    'echo $? > .ffe_exit',
    ''
  ].join('\n')
}

/** Compose the PATH/module setup block for job.sh from a profile's settings. */
export function buildSetup(opts: { remoteTinkerDir?: string; setupCommands?: string }): string {
  const lines: string[] = []
  if (opts.remoteTinkerDir && opts.remoteTinkerDir.trim()) {
    lines.push(`export PATH="${opts.remoteTinkerDir.trim()}:$PATH"`)
  }
  if (opts.setupCommands && opts.setupCommands.trim()) {
    lines.push(opts.setupCommands.trim())
  }
  return lines.join('\n')
}

/**
 * Compose the bare Tinker invocation that goes into job.sh. The coordinate file
 * is passed as the first argument (so Tinker skips that prompt); any remaining
 * interactive answers are fed on stdin via a heredoc — exactly mirroring how the
 * local launcher feeds the option form's answers, so the proven stdin mapping is
 * reused unchanged. Extra positional args (if any) follow the filename.
 */
export function composeTinkerCommand(opts: {
  program: string
  input: string
  args?: string[]
  stdin?: string
}): string {
  const base = [opts.program, opts.input, ...(opts.args ?? [])]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ')
  const stdin = (opts.stdin ?? '').replace(/\n+$/, '')
  if (stdin) return `${base} <<'FFE_EOF'\n${stdin}\nFFE_EOF`
  return base
}

/**
 * Extract the job id from a submit command's stdout. Uses the profile's
 * `submitIdPattern` if given (first capture group of the last match), else
 * falls back to the last whitespace-delimited integer-ish token — covers both
 * `echo $!` (a PID) and `sbatch --parsable` (a numeric job id).
 */
export function extractJobId(stdout: string, pattern?: string): string | null {
  const text = stdout.trim()
  if (!text) return null
  if (pattern) {
    try {
      const re = new RegExp(pattern, 'g')
      let last: RegExpExecArray | null = null
      for (let m = re.exec(text); m; m = re.exec(text)) {
        last = m
        if (re.lastIndex === m.index) re.lastIndex++ // guard against zero-width loops
      }
      if (last) return (last[1] ?? last[0]).trim()
    } catch {
      // fall through to the generic heuristic on a bad user-supplied pattern
    }
  }
  const tokens = text.split(/\s+/).filter((t) => /\d/.test(t))
  return tokens.length ? tokens[tokens.length - 1] : text.split(/\s+/).pop() ?? null
}
