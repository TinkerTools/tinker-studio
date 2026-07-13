import { useEffect, useState } from 'react'
import { CommandsModal } from './CommandsModal'

// Context snapshot shape, derived from the ambient window.tinker type (importing
// the preload source would break the renderer's composite tsconfig).
type CommandsContext = Parameters<Window['tinker']['commandsWindow']['publishContext']>[0]

const EMPTY: CommandsContext = { system: null, clusters: [] }

/**
 * Root of the detachable Modeling Commands window — the Commands panel in its own
 * OS window. The main window owns the active system, launch logic, and viewer, so
 * this window is a form that:
 *  - receives a small context snapshot (active-system summary, Tinker dir,
 *    clusters) relayed from the main window (requesting it on mount);
 *  - forwards local runs fire-and-forget and opens the Jobs window for progress;
 *  - forwards remote submits and awaits a boolean so it can report success/failure.
 */
export function CommandsWindow() {
  const [ctx, setCtx] = useState<CommandsContext>(EMPTY)

  useEffect(() => {
    const off = window.tinker.commandsWindow.onContext(setCtx)
    window.tinker.commandsWindow.requestContext()
    return off
  }, [])

  return (
    <CommandsModal
      embedded
      system={ctx.system}
      tinkerDir={ctx.tinkerDir}
      clusters={ctx.clusters}
      onRun={(program, stdin, watch, requiresStructure, loadResult) =>
        window.tinker.commandsWindow.run({ program, stdin, watch, requiresStructure, loadResult })
      }
      onSubmitRemote={(opts) => window.tinker.commandsWindow.submit(opts)}
      onManageClusters={() => window.tinker.commandsWindow.manageClusters()}
      onStarted={() => window.tinker.jobsWindow.open()}
    />
  )
}
