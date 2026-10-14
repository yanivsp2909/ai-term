import type { ExtensionAccess } from '../shared/extensions.js';
import { validateExtensionCatalog, validateExtensionFile } from '../shared/validate.js';
import type { Request } from './tui/worktree-question.js';

export function socketExtensions(request: Request): ExtensionAccess {
  return {
    list:async cwd=>validateExtensionCatalog((await request({kind:'extensions.list',cwd})).extensions),
    read:async (cwd,extensionId)=>validateExtensionFile((await request({kind:'extensions.read',cwd,extensionId})).extension),
    toggle:async (cwd,extensionId,enabled)=>validateExtensionCatalog((await request({kind:'extensions.toggle',cwd,extensionId,enabled})).extensions),
  };
}
