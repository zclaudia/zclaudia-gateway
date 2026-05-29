import fs from 'fs';
import os from 'os';
import path from 'path';

if (!process.env.ZCLAUDIA_DATA_DIR) {
  process.env.ZCLAUDIA_DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), 'zclaudia-gateway-vitest-'),
  );
}
