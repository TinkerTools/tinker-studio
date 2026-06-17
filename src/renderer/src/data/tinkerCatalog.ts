import commandsJson from './commands.json'
import keywordsJson from './keywords.json'

/**
 * Typed view of the Tinker command and keyword catalogs (generated from the
 * original FFE's commands.xml / keywords.xml by scripts/convert-tinker-xml.py).
 */

export interface TinkerConditional {
  value: string
  description: string
  gui: string
  default: string
}

export interface TinkerOption {
  name: string
  description: string
  gui: string
  default: string
  values: string[]
  conditionals: TinkerConditional[]
}

export interface TinkerCommand {
  name: string
  /** File types this command applies to (XYZ, INT, ARC, PDB). */
  fileTypes: string[]
  actions: string[]
  description: string
  options: TinkerOption[]
}

export interface TinkerKeyword {
  name: string
  /** GUI representation: TEXTFIELD | CHECKBOX | CHECKBOXES | COMBOBOX | EDITCOMBOBOX. */
  rep: string
  description: string
  values: string[]
}

export interface KeywordSection {
  name: string
  keywords: TinkerKeyword[]
}

export const tinkerCommands = commandsJson as TinkerCommand[]
export const keywordSections = keywordsJson as KeywordSection[]
