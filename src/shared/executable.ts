import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { isFsError } from './paths.js';
// The first executable `name` in the absolute folders of PATH, found without a shell or `which`; relative PATH entries
// are skipped because they would resolve against whatever folder AI Term happens to run in.
export async function findExecutable(name: string, path = process.env.PATH ?? ''): Promise<string | null> {
    for (const folder of path.split(delimiter)) {
        if (!isAbsolute(folder))
            continue;
        const candidate = join(folder, name);
        try {
            await access(candidate, constants.X_OK);
            // A searchable directory passes X_OK too; only a file can be the command.
            if ((await stat(candidate)).isFile())
                return candidate;
        }
        catch (error) {
            if (!isFsError(error, 'ENOENT') && !isFsError(error, 'EACCES') && !isFsError(error, 'ENOTDIR'))
                throw error;
        }
    }
    return null;
}
