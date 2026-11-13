import { constants } from 'node:fs';
import { cp, copyFile, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PUBLIC_FILES = [
  'index.html',
  'codex-analysis.html',
  'style.css',
  'service-worker.js',
  'manifest.webmanifest'
];
const OPTIONAL_PUBLIC_FILES = ['CNAME', 'robots.txt', '.nojekyll'];
const PUBLIC_DIRECTORIES = ['assets', 'src'];

export async function preparePagesSite({
  sourceDir = process.cwd(),
  outputDir = path.join(sourceDir, '.pages-site')
} = {}) {
  const source = path.resolve(sourceDir);
  const output = path.resolve(outputDir);
  if (
    source === output ||
    PUBLIC_DIRECTORIES.some((directory) => {
      const relative = path.relative(path.join(source, directory), output);
      return !relative.startsWith('..') && !path.isAbsolute(relative);
    })
  ) {
    throw new Error(
      'Pages output must be separate from the public source files.'
    );
  }
  // Require a fresh directory so a previous artifact cannot retain private files.
  await mkdir(output);
  for (const file of PUBLIC_FILES) {
    await copyFile(
      path.join(source, file),
      path.join(output, file),
      constants.COPYFILE_EXCL
    );
  }
  for (const file of OPTIONAL_PUBLIC_FILES) {
    try {
      await copyFile(
        path.join(source, file),
        path.join(output, file),
        constants.COPYFILE_EXCL
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const directory of PUBLIC_DIRECTORIES) {
    await cp(path.join(source, directory), path.join(output, directory), {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: async (entry) => {
        if ((await lstat(entry)).isSymbolicLink()) {
          throw new Error(
            'Pages public files must not contain symbolic links.'
          );
        }
        return true;
      }
    });
  }
  return output;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  preparePagesSite()
    .then(() => {
      process.stdout.write('Prepared public app files in .pages-site.\n');
    })
    .catch((error) => {
      process.stderr.write(error.message + '\n');
      process.exitCode = 1;
    });
}
