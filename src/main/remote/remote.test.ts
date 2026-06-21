import { describe, it, expect } from 'vitest'
import {
  renderTemplate,
  templateVars,
  buildJobScript,
  buildSetup,
  extractJobId,
  composeTinkerCommand
} from './template'
import { classifyStatus, exitCodeFromStatus } from './status'
import { sshDirectTemplates, slurmTemplates, newClusterProfile } from './presets'

describe('renderTemplate', () => {
  it('substitutes provided variables', () => {
    const { text, missing } = renderTemplate('cd {{workdir}} && run {{job_name}}', {
      workdir: '/scratch/a',
      job_name: 'min1'
    })
    expect(text).toBe('cd /scratch/a && run min1')
    expect(missing).toEqual([])
  })

  it('reports absent variables but treats empty string as provided', () => {
    const { text, missing } = renderTemplate('a {{x}} b {{y}}', { x: '' })
    expect(text).toBe('a  b ')
    expect(missing).toEqual(['y'])
  })

  it('lists referenced variable names', () => {
    expect(templateVars('{{a}} {{b}} {{a}}').sort()).toEqual(['a', 'b'])
  })
})

describe('buildJobScript / buildSetup', () => {
  it('emits a runnable script that records the exit code', () => {
    const s = buildJobScript({
      workdir: '/scratch/run',
      setup: 'export PATH="/opt/tinker/bin:$PATH"',
      tinkerCmd: 'dynamic mol.xyz 1000 1.0 1.0 2 298'
    })
    expect(s.startsWith('#!/bin/sh')).toBe(true)
    expect(s).toContain('cd "/scratch/run" || exit 1')
    expect(s).toContain('export PATH="/opt/tinker/bin:$PATH"')
    expect(s).toContain('dynamic mol.xyz 1000 1.0 1.0 2 298')
    expect(s).toContain('echo $? > .ffe_exit')
  })

  it('omits an empty setup block', () => {
    const s = buildJobScript({ workdir: '/w', tinkerCmd: 'analyze mol.xyz E' })
    expect(s).not.toContain('export PATH')
  })

  it('builds a PATH + module setup block, adding bin / bin-macos / bin-linux', () => {
    expect(buildSetup({ remoteTinkerDir: '/opt/tinker', setupCommands: 'module load tinker' })).toBe(
      'export PATH="/opt/tinker:/opt/tinker/bin:/opt/tinker/bin-macos:/opt/tinker/bin-linux:$PATH"\nmodule load tinker'
    )
    // A trailing slash is normalized.
    expect(buildSetup({ remoteTinkerDir: '/opt/tinker/' })).toBe(
      'export PATH="/opt/tinker:/opt/tinker/bin:/opt/tinker/bin-macos:/opt/tinker/bin-linux:$PATH"'
    )
    expect(buildSetup({})).toBe('')
  })
})

describe('composeTinkerCommand', () => {
  it('passes the coordinate file as an argument and answers via heredoc', () => {
    const cmd = composeTinkerCommand({ program: 'minimize', input: 'mol.xyz', stdin: '0.01\n' })
    expect(cmd).toBe("minimize mol.xyz <<'FFE_EOF'\n0.01\nFFE_EOF")
  })

  it('emits a bare command line when there are no stdin answers', () => {
    const cmd = composeTinkerCommand({ program: 'analyze', input: 'mol.xyz', args: ['E'] })
    expect(cmd).toBe('analyze mol.xyz E')
  })
})

describe('extractJobId', () => {
  it('reads a trailing PID from the ssh-direct submit', () => {
    expect(extractJobId('48213\n', sshDirectTemplates().submitIdPattern)).toBe('48213')
  })

  it('reads an sbatch --parsable job id', () => {
    expect(extractJobId('1234567\n', slurmTemplates().submitIdPattern)).toBe('1234567')
  })

  it('handles sbatch --parsable cluster suffix (jobid;cluster)', () => {
    // default pattern (\d+) takes the first run of digits
    expect(extractJobId('1234567;cluster\n', slurmTemplates().submitIdPattern)).toBe('1234567')
  })

  it('falls back to the last numeric token without a pattern', () => {
    expect(extractJobId('Submitted batch job 99\n')).toBe('99')
  })
})

describe('classifyStatus', () => {
  it('maps ssh-direct template output', () => {
    expect(classifyStatus('RUNNING')).toBe('running')
    expect(classifyStatus('COMPLETED')).toBe('completed')
    expect(classifyStatus('FAILED:1')).toBe('failed')
    expect(classifyStatus('UNKNOWN')).toBe('unknown')
    expect(classifyStatus('')).toBe('unknown')
  })

  it('maps SLURM sacct State words', () => {
    expect(classifyStatus('RUNNING')).toBe('running')
    expect(classifyStatus('COMPLETED')).toBe('completed')
    expect(classifyStatus('FAILED')).toBe('failed')
    expect(classifyStatus('PENDING')).toBe('pending')
    expect(classifyStatus('CANCELLED')).toBe('canceled')
    expect(classifyStatus('TIMEOUT')).toBe('failed')
    expect(classifyStatus('OUT_OF_MEMORY')).toBe('failed')
  })

  it('maps squeue compact ST codes', () => {
    expect(classifyStatus('PD')).toBe('pending')
    expect(classifyStatus('R')).toBe('running')
    expect(classifyStatus('CD')).toBe('completed')
    expect(classifyStatus('F')).toBe('failed')
    expect(classifyStatus('CA')).toBe('canceled')
  })

  it('extracts exit codes from ssh-direct status', () => {
    expect(exitCodeFromStatus('FAILED:137')).toBe(137)
    expect(exitCodeFromStatus('COMPLETED')).toBe(0)
    expect(exitCodeFromStatus('RUNNING')).toBeUndefined()
  })
})

describe('newClusterProfile', () => {
  it('seeds SLURM defaults', () => {
    const p = newClusterProfile('slurm')
    expect(p.kind).toBe('slurm')
    expect(p.templates.submit).toContain('sbatch')
    expect(p.variables.some((v) => v.name === 'sbatch_args')).toBe(true)
  })

  it('seeds ssh-direct defaults with a unique id', () => {
    const a = newClusterProfile('ssh-direct')
    const b = newClusterProfile('ssh-direct')
    expect(a.id).not.toBe(b.id)
    expect(a.templates.submit).toContain('nohup')
  })
})
