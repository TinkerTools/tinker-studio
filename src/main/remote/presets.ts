import type { ClusterKind, ClusterProfile, ClusterTemplates, ClusterVariable } from './types'

/**
 * Default command templates for each built-in cluster kind. These are seeded
 * into a new profile and remain fully editable — `custom` simply starts from the
 * ssh-direct set as a blank-ish canvas.
 *
 * All templates assume FFE has already created the remote working directory,
 * uploaded the inputs, and written `job.sh` (which cds in, runs the setup +
 * Tinker command, and records the exit code to `.ffe_exit`). The templates only
 * launch / query / cancel that script.
 */

/** Run directly on the SSH host as a detached background process, tracked by PID. */
export function sshDirectTemplates(): ClusterTemplates {
  return {
    submit:
      'cd "{{workdir}}" && nohup sh job.sh > "{{job_name}}.log" 2>&1 & echo $!',
    status:
      'if kill -0 {{job_id}} 2>/dev/null; then echo RUNNING; ' +
      'elif [ -f "{{workdir}}/.ffe_exit" ]; then ' +
      'c=$(cat "{{workdir}}/.ffe_exit"); ' +
      'if [ "$c" = 0 ]; then echo COMPLETED; else echo "FAILED:$c"; fi; ' +
      'else echo UNKNOWN; fi',
    cancel: 'kill {{job_id}} 2>/dev/null; echo canceled',
    submitIdPattern: '(\\d+)\\s*$'
  }
}

/** Submit to a SLURM queue with sbatch; track via sacct; cancel via scancel. */
export function slurmTemplates(): ClusterTemplates {
  return {
    submit:
      'cd "{{workdir}}" && sbatch --parsable --job-name="{{job_name}}" ' +
      '--output="{{job_name}}.log" {{sbatch_args}} job.sh',
    status: 'sacct -j {{job_id}} --format=State --noheader --parsable2 2>/dev/null | head -1',
    cancel: 'scancel {{job_id}}',
    submitIdPattern: '(\\d+)'
  }
}

export function templatesFor(kind: ClusterKind): ClusterTemplates {
  if (kind === 'slurm') return slurmTemplates()
  return sshDirectTemplates() // ssh-direct and custom both start here
}

/** Default user-defined variables for a kind (SLURM exposes an sbatch args field). */
export function variablesFor(kind: ClusterKind): ClusterVariable[] {
  if (kind === 'slurm') {
    return [
      {
        name: 'sbatch_args',
        label: 'sbatch arguments',
        default: '--time=24:00:00 --nodes=1 --ntasks=1',
        description: 'Resource flags passed to sbatch (partition, time, cores, …).'
      }
    ]
  }
  return []
}

let counter = 0
function newId(): string {
  counter += 1
  return `cl-${Date.now().toString(36)}-${counter}`
}

/** Create a fresh profile of the given kind, pre-seeded with sensible defaults. */
export function newClusterProfile(kind: ClusterKind, name?: string): ClusterProfile {
  return {
    id: newId(),
    name: name ?? defaultName(kind),
    kind,
    host: '',
    remoteBaseDir: '~/ffe-jobs',
    variables: variablesFor(kind),
    templates: templatesFor(kind)
  }
}

function defaultName(kind: ClusterKind): string {
  if (kind === 'slurm') return 'New SLURM cluster'
  if (kind === 'custom') return 'New custom cluster'
  return 'New SSH host'
}
