const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const unzipper = require('unzipper');
const { spawn, exec } = require('child_process');
const http = require('http');

// Bot Token
const BOT_TOKEN = '8687845093:AAHD_LFJSlTbFt3FkBKOffC6AzXjIaMzKCk';
const bot = new Telegraf(BOT_TOKEN);

const userSessions = {};
const HOST_DIR = path.join(__dirname, 'hosted_apps');
fs.ensureDirSync(HOST_DIR);

// 1. Start Command & Inline Keyboard
bot.start((ctx) => {
  ctx.reply(
    'Welcome to Node.js Telegram Host Bot! 🚀\nSelect an option below:',
    Markup.inlineKeyboard([
      [Markup.button.callback('📦 Upload Zip & Host', 'UPLOAD_ZIP')],
      [Markup.button.callback('🛑 Stop Current Process', 'STOP_PROCESS')]
    ])
  );
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
    session.process.kill();
    session.process = null;
    ctx.reply('✅ Process stopped successfully.');
  } else {
    ctx.reply('⚠️ No active process running.');
  }
});

// 2. Message Handler
bot.on('message', async (ctx) => {
  const userId = ctx.from.id;
  let session = userSessions[userId];

  // Handle ZIP File Upload
  if (ctx.message.document && session && session.state === 'WAITING_FOR_ZIP') {
    const doc = ctx.message.document;

    if (!doc.file_name.endsWith('.zip')) {
      return ctx.reply('❌ Please upload a valid `.zip` archive.');
    }

    ctx.reply('📥 Downloading and extracting your archive...');

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

        // Auto-detect root directory if files are nested inside a subfolder
        let targetDir = userDir;
        let files = await fs.readdir(userDir);

        if (files.length === 1) {
          const subFolderPath = path.join(userDir, files[0]);
          const stat = await fs.stat(subFolderPath);
          if (stat.isDirectory()) {
            targetDir = subFolderPath; // Shift execution directory to nested subfolder
          }
        }

        session.userDir = targetDir;

        // Check & Install Dependencies Automatically
        const packageJsonPath = path.join(targetDir, 'package.json');
        if (await fs.pathExists(packageJsonPath)) {
          ctx.reply('📦 `package.json` found! Automatically running `npm install`...', { parse_mode: 'Markdown' });

          exec('npm install', { cwd: targetDir }, (error, stdout, stderr) => {
            if (error) {
              ctx.reply(`❌ npm install failed:\n\`\`\`\n${stderr}\n\`\`\``, { parse_mode: 'Markdown' });
            } else {
              ctx.reply('✅ Dependencies installed successfully!');
            }
            askForCommand(ctx, session);
          });
        } else {
          ctx.reply('ℹ️ No `package.json` found. Skipping package installation.');
          askForCommand(ctx, session);
        }
      });
    } catch (err) {
      ctx.reply(`❌ Error unpacking file: ${err.message}`);
    }
    return;
  }

  // Handle Start Command Entry
  if (ctx.message.text && session && session.state === 'WAITING_FOR_COMMAND') {
    const command = ctx.message.text.trim();
    session.command = command;
    session.state = 'RUNNING';

    ctx.reply(`🚀 Starting process with command: \`${command}\`...\n`, { parse_mode: 'Markdown' });
    runProcess(ctx, userId);
    return;
  }

  // Forward User Input Stream to Active Running Process
  if (ctx.message.text && session && session.state === 'RUNNING' && session.process) {
    const userInput = ctx.message.text;
    session.process.stdin.write(userInput + '\n');
    return;
  }
});

function askForCommand(ctx, session) {
  session.state = 'WAITING_FOR_COMMAND';
  ctx.reply(
    'Please send the execution command.\nDefault: `node index.js`',
    { parse_mode: 'Markdown' }
  );
}

// 3. Process Execution & Terminal Output Streaming
function runProcess(ctx, userId) {
  const session = userSessions[userId];
  const parts = session.command.split(' ');
  const cmd = parts[0];
  const args = parts.slice(1);

  const child = spawn(cmd, args, {
    cwd: session.userDir,
    shell: true
  });

  session.process = child;

  child.stdout.on('data', (data) => {
    const output = data.toString().trim();
    if (output) {
      ctx.reply(`\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
    }
  });

  child.stderr.on('data', (data) => {
    const output = data.toString().trim();
    if (output) {
      ctx.reply(`⚠️ **STDERR:**\n\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
    }
  });

  child.on('close', (code) => {
    ctx.reply(`🏁 Process exited with code ${code}`);
    if (userSessions[userId]) {
      userSessions[userId].state = 'IDLE';
      userSessions[userId].process = null;
    }
  });

  child.on('error', (err) => {
    ctx.reply(`❌ Failed to start process: ${err.message}`);
  });
}

// Connect Bot to Telegram
bot.launch().then(() => console.log('Telegram Bot successfully connected!'));

// 4. Railway Health Check Listener (Keeps Railway from crashing)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Railway Host Server Active\n');
}).listen(PORT, () => {
  console.log(`Health check server running on port ${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
