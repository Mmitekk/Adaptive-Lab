import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
app.use('/Adaptive-Lab', express.static(path.join(root, 'dist-pages')));
app.use((req, res) => res.status(404).send('Статическая публикация доступна по /Adaptive-Lab/; API отсутствует.'));
const port = Number(process.env.PORT || 4188);
const server = app.listen(port, '127.0.0.1', () => console.log(`Pages preview: http://127.0.0.1:${port}/Adaptive-Lab/`));
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Порт ${port} занят. Укажите другой PORT; чужие процессы не остановлены.` : error.message); process.exitCode = 1; });
