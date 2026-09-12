const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const unzipper = require('unzipper');
const { spawn } = require('child_process');
const http = require('http');

const BOT_TOKEN = '8687845093:AAHD_LFJSlTbFt3FkBKOffC6AzXjIaMzKCk';
const bot = new Telegraf(BOT_TOKEN);

const userSessions = {};
const HOST_DIR = path.join(__dirname, 'hosted_apps');
fs.ensureDirSync(HOST_DIR);

// Folders/files that should NEVER be deleted automatically
const PROTECTED_PATHS = ['session', 'auth_info_baileys', 'state', 'auth', 'creds.json'];

function getMainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📦 Upload Zip & Host', 'UPLOAD_ZIP')],
    [Markup.button.callback('📂 Manage Uploaded Files', 'MANAGE_FILES')],
    [Markup.button.callback('🛑 Stop Current Process', 'STOP_PROCESS')]
  ]);
}

bot.start((ctx) => {
  ctx.reply('Welcome to Node.js Host Bot! 🚀 Select an option:', getMainMenu());
});

bot.action('UPLOAD_ZIP', (ctx) => {
  const userId = ctx.from.id;
  userSessions[userId] = { state: 'WAITING_FOR_ZIP' };
  ctx.reply('Please upload your project `.zip` file now.');
});

bot.action('STOP_PROCESS', (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions[userId];

  if (session && session.process) {
    if (session.logTimer) clearTimeout(session.logTimer);
    session.process.kill('SIGTERM');
    session.process = null;
    ctx.reply('✅ Running process stopped successfully.', getMainMenu());
  } else {
    ctx.reply('⚠️ No active process running.', getMainMenu());
  }
});

bot.action('MANAGE_FILES', async (ctx) => {
  const userId = ctx.from.id;
  const userDir = path.join(HOST_DIR, `user_${userId}`);

  if (!(await fs.pathExists(userDir))) {
    return ctx.reply('📂 No files uploaded yet.', getMainMenu());
  }

  await showFileList(ctx, userDir);
});

async function scanJsFiles(dir, baseDir = dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const items = await fs.readdir(dir);

  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = await fs.stat(fullPath);

    if (stat.isDirectory() && item !== 'node_modules') {
      const subFiles = await scanJsFiles(fullPath, baseDir);
      results = results.concat(subFiles);
    } else if (item.endsWith('.js')) {
      const relativePath = path.relative(baseDir, fullPath);
      results.push({ name: item, relativePath, fullPath, dir: path.dirname(fullPath) });
    }
  }
  return results;
}

async function showFileList(ctx, userDir) {
  try {
    const files = await fs.readdir(userDir);
    const jsFiles = await scanJsFiles(userDir);

    if (files.length === 0) {
      return ctx.reply('📂 Directory is empty.', getMainMenu());
    }

    let buttons = [];
    jsFiles.forEach((file) => {
      buttons.push([Markup.button.callback(`▶️ Run ${file.name}`, `RUN_${file.name}`)]);
    });

    buttons.push([Markup.button.callback('⚙️ Custom Command Prompt', 'ASK_CUSTOM_CMD')]);
    buttons.push([Markup.button.callback('🗑️ Delete All Project Files', 'DELETE_ALL')]);
    buttons.push([Markup.button.callback('🔙 Back to Main Menu', 'MAIN_MENU')]);

    const fileListText = files.map((f) => `• \`${f}\``).join('\n');
    ctx.reply(`📂 **Uploaded Files & Actions:**\n\n${fileListText}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons)
    });
  } catch (err) {
    ctx.reply(`❌ Error listing files: ${err.message}`);
  }
}

bot.action('ASK_CUSTOM_CMD', (ctx) => {
  promptForCommand(ctx);
});

bot.action('MAIN_MENU', (ctx) => {
  ctx.reply('Main Menu:', getMainMenu());
});

bot.action('DELETE_ALL', async (ctx) => {
  const userId = ctx.from.id;
  const userDir = path.join(HOST_DIR, `user_${userId}`);

  if (userSessions[userId] && userSessions[userId].process) {
    if (userSessions[userId].logTimer) clearTimeout(userSessions[userId].logTimer);
    userSessions[userId].process.kill('SIGTERM');
    userSessions[userId].process = null;
  }

  await fs.remove(userDir);
  ctx.reply('🗑️ All project files (including session data) deleted cleanly.', getMainMenu());
});

function promptForCommand(ctx) {
  const userId = ctx.from.id;
  userSessions[userId] = userSessions[userId] || {};
  userSessions[userId].state = 'WAITING_FOR_COMMAND';

  ctx.reply(
    '⌨️ **Please send your execution command now.**\n\nExamples:\n• `node index.js`\n• `npm start`',
    { parse_mode: 'Markdown' }
  );
}

async function safeCleanUserDirectory(userDir) {
  if (!(await fs.pathExists(userDir))) return;

  const items = await fs.readdir(userDir);
  for (const item of items) {
    if (!PROTECTED_PATHS.includes(item) && item !== 'node_modules') {
      await fs.remove(path.join(userDir, item));
    }
  }
}

bot.action(/^RUN_(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const fileName = ctx.match[1];
  const userDir = path.join(HOST_DIR, `user_${userId}`);

  let targetDir = userDir;
  let targetFilePath = path.join(userDir, fileName);

  if (!fs.existsSync(targetFilePath)) {
    const allJsFiles = await scanJsFiles(userDir);
    const matchedFile = allJsFiles.find((f) => f.name === fileName);

    if (matchedFile) {
      targetDir = matchedFile.dir;
      targetFilePath = matchedFile.fullPath;
    }
  }

  if (!fs.existsSync(targetFilePath)) {
    return ctx.reply(`❌ Could not locate \`${fileName}\` in project directory.`, { parse_mode: 'Markdown' });
  }

  const session = userSessions[userId] || {};
  session.userDir = targetDir;
  session.command = `node ${fileName}`;
  session.state = 'RUNNING';
  userSessions[userId] = session;

  ctx.reply(`🚀 Executing: \`node ${fileName}\` (Optimized for 1GB RAM)...\n`, { parse_mode: 'Markdown' });
  runProcess(ctx, userId);
});

bot.on('message', async (ctx) => {
  const userId = ctx.from.id;
  let session = userSessions[userId];

  if (ctx.message.document && session && session.state === 'WAITING_FOR_ZIP') {
    const doc = ctx.message.document;

    if (!doc.file_name.endsWith('.zip')) {
      return ctx.reply('❌ Please upload a valid `.zip` file.');
    }

    ctx.reply('📥 Downloading and extracting archive (Preserving Auth Files)...');

    try {
      const fileLink = await ctx.telegram.getFileLink(doc.file_id);
      const userDir = path.join(HOST_DIR, `user_${userId}`);

      await fs.ensureDir(userDir);
      
      if (session && session.process) {
        if (session.logTimer) clearTimeout(session.logTimer);
        session.process.kill('SIGTERM');
        session.process = null;
      }

      await safeCleanUserDirectory(userDir);

      const response = await axios({ url: fileLink.href, responseType: 'stream' });
      const zipPath = path.join(userDir, 'app.zip');
      const writer = fs.createWriteStream(zipPath);

      response.data.pipe(writer);

      writer.on('finish', async () => {
        await fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: userDir })).promise();
        await fs.remove(zipPath);

        let targetDir = userDir;
        let files = await fs.readdir(userDir);
        if (files.length === 1) {
          const subFolderPath = path.join(userDir, files[0]);
          const stat = await fs.stat(subFolderPath);
          if (stat.isDirectory()) targetDir = subFolderPath;
        }

        session.userDir = targetDir;

        const packageJsonPath = path.join(targetDir, 'package.json');
        if (await fs.pathExists(packageJsonPath)) {
          ctx.reply('📦 Starting `npm install`...', { parse_mode: 'Markdown' });

          const npmInstaller = spawn('npm', ['install', '--no-audit', '--no-fund'], {
            cwd: targetDir,
            shell: true,
            env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=900' }
          });

          npmInstaller.on('close', (code) => {
            if (code === 0) {
              ctx.reply('✅ Dependencies installed successfully!');
            } else {
              ctx.reply(`⚠️ \`npm install\` finished with code ${code}.`);
            }
            promptForCommand(ctx);
          });
        } else {
          promptForCommand(ctx);
        }
      });
    } catch (err) {
      ctx.reply(`❌ Extraction failed: ${err.message}`);
    }
    return;
  }

  if (ctx.message.text && session && session.state === 'WAITING_FOR_COMMAND') {
    const command = ctx.message.text.trim();
    session.command = command;
    session.state = 'RUNNING';

    ctx.reply(`🚀 Starting process with command: \`${command}\` (Optimized for 1GB RAM)...\n`, { parse_mode: 'Markdown' });
    runProcess(ctx, userId);
    return;
  }

  if (ctx.message.text && session && session.state === 'RUNNING' && session.process) {
    session.process.stdin.write(ctx.message.text + '\n');
    return;
  }
});

function runProcess(ctx, userId) {
  const session = userSessions[userId];
  const parts = session.command.split(' ');
  const cmd = parts[0];
  const args = parts.slice(1);

  // Set memory limit to 900MB to leave headroom for the panel itself inside 1GB total RAM
  const child = spawn(cmd, args, { 
    cwd: session.userDir, 
    shell: true,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=900' }
  });
  
  session.process = child;

  let stdoutBuffer = '';
  let stderrBuffer = '';
  let stdoutTimer = null;
  let stderrTimer = null;

  const flushStdout = () => {
    if (!stdoutBuffer.trim()) return;
    const text = stdoutBuffer.trim();
    const truncated = text.length > 3500 ? text.slice(-3500) : text;
    ctx.reply(`\`\`\`\n${truncated}\n\`\`\``, { parse_mode: 'Markdown' }).catch(() => {});
    stdoutBuffer = '';
  };

  const flushStderr = () => {
    if (!stderrBuffer.trim()) return;
    const text = stderrBuffer.trim();
    const truncated = text.length > 3500 ? text.slice(-3500) : text;
    ctx.reply(`⚠️ **STDERR:**\n\`\`\`\n${truncated}\n\`\`\``, { parse_mode: 'Markdown' }).catch(() => {});
    stderrBuffer = '';
  };

  child.stdout.on('data', (data) => {
    stdoutBuffer += data.toString();
    if (!stdoutTimer) {
      stdoutTimer = setTimeout(() => {
        flushStdout();
        stdoutTimer = null;
      }, 1500); // Send live logs grouped every 1.5 seconds
    }
  });

  child.stderr.on('data', (data) => {
    stderrBuffer += data.toString();
    if (!stderrTimer) {
      stderrTimer = setTimeout(() => {
        flushStderr();
        stderrTimer = null;
      }, 1500);
    }
  });

  child.on('close', (code) => {
    if (stdoutTimer) clearTimeout(stdoutTimer);
    if (stderrTimer) clearTimeout(stderrTimer);
    flushStdout();
    flushStderr();

    ctx.reply(`🏁 Process exited with code ${code}`, getMainMenu());
    if (userSessions[userId]) {
      userSessions[userId].state = 'IDLE';
      userSessions[userId].process = null;
    }
  });
}

bot.launch().then(() => console.log('Host Bot is online!'));

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Railway Host Alive\n');
}).listen(PORT);
       
