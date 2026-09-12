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

// Safely clear old application files while preserving WhatsApp authentication sessions
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

  ctx.reply(`🚀 Executing: \`node ${fileName}\`...\n`, { parse_mode: 'Markdown' });
  runProcess(ctx, userId);
});

bot.on('message', async (ctx) => {
  const userId = ctx.from.id;
  let session = userSessions[userId];

  // Handle ZIP upload without deleting existing WhatsApp auth files
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
      
      // Stop running process if active
      if (session && session.process) {
        session.process.kill('SIGTERM');
        session.process = null;
      }

      // Safely delete code files while preserving 'session', 'auth', 'creds.json'
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
          ctx.reply('📦 Starting `npm install` (Live Stream)...', { parse_mode: 'Markdown' });

          const npmInstaller = spawn('npm', ['install', '--no-audit', '--no-fund'], {
            cwd: targetDir,
            shell: true
          });

          npmInstaller.stdout.on('data', (data) => {
            const output = data.toString().trim();
            if (output) ctx.reply(`\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
          });

          npmInstaller.stderr.on('data', (data) => {
            const output = data.toString().trim();
            if (output) ctx.reply(`⚠️ \`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
          });

          npmInstaller.on('close', (code) => {
            if (code === 0) {
              ctx.reply('✅ Dependencies installed successfully!');
            } else {
              ctx.reply(`⚠️ \`npm install\` exited with code ${code}.`);
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

    ctx.reply(`🚀 Starting process with command: \`${command}\`...\n`, { parse_mode: 'Markdown' });
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

  const child = spawn(cmd, args, { cwd: session.userDir, shell: true });
  session.process = child;

  child.stdout.on('data', (data) => {
    const output = data.toString().trim();
    if (output) ctx.reply(`\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
  });

  child.stderr.on('data', (data) => {
    const output = data.toString().trim();
    if (output) ctx.reply(`⚠️ **STDERR:**\n\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
  });

  child.on('close', (code) => {
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
