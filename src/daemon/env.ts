// Only the architecture's always rules apply to the internal shell engine.
export function buildShellEnv(base: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(base)) {
        if (value !== undefined && !/^npm_/i.test(key) && !/^AI_TERM_/.test(key) && !['INIT_CWD', 'NODE_ENV'].includes(key))
            result[key] = value;
    }
    Object.assign(result, { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'AITerm' });
    if (!result.LANG && !result.LC_ALL && !result.LC_CTYPE)
        result.LANG = 'en_US.UTF-8';
    return result;
}
