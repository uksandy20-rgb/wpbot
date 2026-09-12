const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const unzipper = require('unzipper');
const { spawn } = require('child_process');
const http = require('http');

// Replace with your Telegram Bot Token
const BOT_TOKEN = '8687845093:AAHD_LFJSlTbFt3FkBKOffC6AzXjIaMzKCk';
const bot = new Telegraf(BOT_TOKEN);

const userSessions = {};
const HOST_DIR = path.join(__dirname, 'hosted_apps');
fs.ensureDirSync(HOST_DIR);

// Main Navigation Keyboard
function getMainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📦 Upload Zip & Host', 'UPLOAD_ZIP')],
    [Markup.button.callback('📂 Manage Uploaded Files', 'MANAGE_FILES')],
    [Markup.button.callback('🛑 Stop Current Process', 'STOP_PROCESS')]
  ]);
}

// Start Command
bot.start((ctx) => {
  ctx.reply('Welcome to Node.js Host Bot! 🚀 Select an option:', getMainMenu());
});

// Callback: Trigger ZIP Upload State
bot.action('UPLOAD_ZIP', (ctx) => {
  const userId = ctx.from.id;
  userSessions[userId] = { state: 'WAITING_FOR_ZIP' };
  ctx.reply('Please upload your project `.zip` file now.');
});

// Callback: Stop Active Running Process
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

// Callback: Open File Manager
bot.action('MANAGE_FILES', async (ctx) => {
  const userId = ctx.from.id;
  const userDir = path.join(HOST_DIR, `user_${userId}`);

  if (!(await fs.pathExists(userDir))) {
    return ctx.reply('📂 No files uploaded yet.', getMainMenu());
  }

  await showFileList(ctx, userDir);
});

// Helper: Scan directory recursively to collect all .js files
async function scanJsFiles(dir, baseDir = dir) {
  let results = [];
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

// Dynamic File Menu Generator
async function showFileList(ctx, userDir) {
  try {
    const files = await fs.readdir(userDir);
    const jsFiles = await scanJsFiles(userDir);

    if (files.length === 0) {
      return ctx.reply('📂 Directory is empty.', getMainMenu());
    }

    let buttons = [];

    // Add execution buttons for each JavaScript file
    jsFiles.forEach((file) => {
      buttons.push([Markup.button.callback(`▶️ Run ${file.name}`, `RUN_${file.name}`)]);
    });

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

bot.action('MAIN_MENU', (ctx) => {
  ctx.reply('Main Menu:', getMainMenu());
});

// Callback: Delete All Files
bot.action('DELETE_ALL', async (ctx) => {
  const userId = ctx.from.id;
  const userDir = path.join(HOST_DIR, `user_${userId}`);

  if (userSessions[userId] && userSessions[userId].process) {
    userSessions[userId].process.kill('SIGTERM');
    userSessions[userId].process = null;
  }

  await fs.remove(userDir);
  ctx.reply('🗑️ All project files deleted cleanly.', getMainMenu());
});

// Callback: Execute Specific Node File (Fixes Subfolder Path Errors)
bot.action(/^RUN_(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const fileName = ctx.match[1];
  const userDir = path.join(HOST_DIR, `user_${userId}`);

  let targetDir = userDir;
  let targetFilePath = path.join(userDir, fileName);

  // Deep search in nested folders if not directly in user root
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

  ctx.reply(`🚀 Starting: \`node ${fileName}\` inside \`${path.basename(targetDir)}\`...\n`, { parse_mode: 'Markdown' });
  runProcess(ctx, userId);
});

// Handle incoming ZIP uploads & interactive console input
bot.on('message', async (ctx) => {
  const userId = ctx.from.id;
  let session = userSessions[userId];

  // Process Document / ZIP Upload
  if (ctx.message.document && session && session.state === 'WAITING_FOR_ZIP') {
    const doc = ctx.message.document;

    if (!doc.file_name.endsWith('.zip')) {
      return ctx.reply('❌ Please upload a valid `.zip` file.');
    }

    ctx.reply('📥 Downloading and extracting archive...');

    try {
      const fileLink = await ctx.telegram.getFileLink(doc.file_id);
      const userDir = path.join(HOST_DIR, `user_${userId}`);

      await fs.remove(userDir);
      await fs.ensureDir(userDir);

      const response = await axios({ url: fileLink.href, responseType: 'stream' });
      const zipPath = path.join(userDir, 'app.zip');
      const writer = fs.createWriteStream(zipPath);

      response.data.pipe(writer);

      writer.on('finish', async () => {
        await fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: userDir })).promise();
        await fs.remove(zipPath);

        // Auto-detect root path if files are nested inside a single subfolder
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
            showFileList(ctx, targetDir);
          });
        } else {
          showFileList(ctx, targetDir);
        }
      });
    } catch (err) {
      ctx.reply(`❌ Extraction failed: ${err.message}`);
    }
    return;
  }

  // Interactive STDIN Stream (Forward User Messages to Active Terminal Process)
  if (ctx.message.text && session && session.state === 'RUNNING' && session.process) {
    session.process.stdin.write(ctx.message.text + '\n');
    return;
  }
});

// Process Spawn Engine
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
    ctx.reply(`🏁 Process stopped with code ${code}`, getMainMenu());
    if (userSessions[userId]) {
      userSessions[userId].state = 'IDLE';
      userSessions[userId].process = null;
    }
  });
}

bot.launch().then(() => console.log('Host Bot is online!'));

// Railway Health-Check Server
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Railway Host Alive\n');
}).listen(PORT);
        
