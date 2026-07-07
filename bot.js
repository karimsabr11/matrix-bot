require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  AttachmentBuilder,
} = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const JsBarcode = require('jsbarcode');

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const ROLE_ID = '1523422859324817559';

// --- Admin system ---
const ADMINS_FILE = path.join(__dirname, 'admins.json');

function loadAdmins() {
  try {
    if (fs.existsSync(ADMINS_FILE)) {
      return JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf-8'));
    }
  } catch {}
  // Default owner
  return ['1219810978708066365'];
}

function saveAdmins(admins) {
  fs.writeFileSync(ADMINS_FILE, JSON.stringify(admins, null, 2));
}

function isAdmin(userId) {
  const admins = loadAdmins();
  return admins.includes(userId);
}

// Initialize admins file if it doesn't exist
if (!fs.existsSync(ADMINS_FILE)) {
  saveAdmins(['1219810978708066365']);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// --- Slash command definitions ---
const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Post the barcode generator panel'),
  new SlashCommandBuilder()
    .setName('grant')
    .setDescription('Grant barcode generator access to a user')
    .addUserOption((opt) =>
      opt.setName('user').setDescription('User to grant access').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('revoke')
    .setDescription('Revoke barcode generator access from a user')
    .addUserOption((opt) =>
      opt.setName('user').setDescription('User to revoke access').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('gen')
    .setDescription('Generate an Asda barcode')
    .addStringOption((opt) =>
      opt
        .setName('barcode')
        .setDescription('Product barcode (8-13 digits)')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('price')
        .setDescription('Price in £ (e.g. 0.10)')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('allow')
    .setDescription('Add a bot admin who can use all commands')
    .addUserOption((opt) =>
      opt.setName('user').setDescription('User to make admin').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('disallow')
    .setDescription('Remove a bot admin')
    .addUserOption((opt) =>
      opt.setName('user').setDescription('User to remove as admin').setRequired(true)
    ),
].map((cmd) => cmd.toJSON());

// --- Register commands on startup ---
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

// --- Luhn check digit calculation ---
function luhnCheckDigit(digits) {
  const nums = digits.split('').map(Number);
  let sum = 0;
  for (let i = 0; i < nums.length; i++) {
    let n = nums[nums.length - 1 - i];
    if (i % 2 === 0) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return ((10 - (sum % 10)) % 10).toString();
}

// --- Generate Asda barcode string ---
function generateAsdaBarcode(productBarcode, priceInPence) {
  const prefix = '510';
  const pricePadded = priceInPence.toString().padStart(5, '0');
  const suffix = '1960';
  const body = prefix + productBarcode + pricePadded + suffix;
  const checkDigit = luhnCheckDigit(body);
  return body + checkDigit;
}

// --- Fetch product info from OpenFoodFacts ---
async function fetchProductInfo(barcode) {
  try {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`
    );
    if (!res.ok) return { name: null, imageUrl: null };
    const data = await res.json();
    return {
      name: data?.product?.product_name || null,
      imageUrl: data?.product?.image_front_url || data?.product?.image_url || null,
    };
  } catch {
    return { name: null, imageUrl: null };
  }
}

// --- Simple box blur for background ---
function stackBlur(sourceCanvas, radius) {
  // Multi-pass downscale/upscale blur for smooth result
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const passes = 3;
  let current = sourceCanvas;
  
  for (let i = 0; i < passes; i++) {
    const smallW = Math.max(1, Math.floor(w / (radius / passes)));
    const smallH = Math.max(1, Math.floor(h / (radius / passes)));
    const small = createCanvas(smallW, smallH);
    const sCtx = small.getContext('2d');
    sCtx.drawImage(current, 0, 0, smallW, smallH);
    
    const big = createCanvas(w, h);
    const bCtx = big.getContext('2d');
    bCtx.drawImage(small, 0, 0, w, h);
    current = big;
  }
  return current;
}

// --- Load logo image (cached) ---
let logoCache = null;
async function getLogo() {
  if (logoCache) return logoCache;
  const logoPath = path.join(__dirname, 'assets', 'logo.jpg');
  if (fs.existsSync(logoPath)) {
    logoCache = await loadImage(logoPath);
    return logoCache;
  }
  // Try png fallback
  const pngPath = path.join(__dirname, 'assets', 'logo.png');
  if (fs.existsSync(pngPath)) {
    logoCache = await loadImage(pngPath);
    return logoCache;
  }
  return null;
}

// --- Fetch image from URL ---
async function fetchImage(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return await loadImage(buffer);
  } catch {
    return null;
  }
}

// --- Draw rounded rect helper ---
function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// --- Render barcode image (new design) ---
async function renderBarcodeImage(asdaBarcode, productName, price, productImageUrl) {
  const size = 1080; // 1:1 square
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // --- Background: logo blurred properly ---
  const logo = await getLogo();
  
  // Fill dark navy base
  ctx.fillStyle = '#1a1a4e';
  ctx.fillRect(0, 0, size, size);

  if (logo) {
    // Draw logo full size onto a temp canvas, then blur it
    const bgCanvas = createCanvas(size, size);
    const bgCtx = bgCanvas.getContext('2d');
    
    // Draw logo centered and scaled to cover
    const scale = Math.max(size / logo.width, size / logo.height);
    const lw = logo.width * scale;
    const lh = logo.height * scale;
    bgCtx.drawImage(logo, (size - lw) / 2, (size - lh) / 2, lw, lh);
    
    // Apply blur
    const blurred = stackBlur(bgCanvas, 12);
    
    // Draw blurred background at full opacity
    ctx.drawImage(blurred, 0, 0, size, size);
    
    // Slight dark overlay for text readability
    ctx.fillStyle = 'rgba(10, 10, 40, 0.45)';
    ctx.fillRect(0, 0, size, size);
  }

  // --- Title: "Matrix Asda Gen" ---
  ctx.textAlign = 'center';
  const titleGradient = ctx.createLinearGradient(size / 2 - 200, 0, size / 2 + 200, 0);
  titleGradient.addColorStop(0, '#10b981');
  titleGradient.addColorStop(1, '#a3e635');
  ctx.fillStyle = titleGradient;
  ctx.font = 'bold 52px sans-serif';
  ctx.fillText('Matrix Asda Gen', size / 2, 80);

  // --- Product name ---
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 38px sans-serif';
  const displayName = productName || 'Unknown Product';
  const maxWidth = size - 100;
  if (ctx.measureText(displayName).width > maxWidth) {
    ctx.font = 'bold 30px sans-serif';
  }
  ctx.fillText(displayName, size / 2, 140, maxWidth);

  // --- Price ---
  ctx.fillStyle = '#10b981';
  ctx.font = 'bold 54px sans-serif';
  ctx.fillText(`£${price}`, size / 2, 210);

  // --- Product image (if available) ---
  let barcodeYStart = 240;
  if (productImageUrl) {
    const productImg = await fetchImage(productImageUrl);
    if (productImg) {
      const imgSize = 380;
      const imgX = (size - imgSize) / 2;
      const imgY = 250;
      
      // Subtle border around product image
      ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
      roundedRect(ctx, imgX - 8, imgY - 8, imgSize + 16, imgSize + 16, 22);
      ctx.fill();
      
      // Draw product image clipped to rounded rect
      ctx.save();
      roundedRect(ctx, imgX, imgY, imgSize, imgSize, 16);
      ctx.clip();
      ctx.drawImage(productImg, imgX, imgY, imgSize, imgSize);
      ctx.restore();
      
      barcodeYStart = imgY + imgSize + 40;
    }
  }

  // --- Barcode: full width, white rounded box ---
  const barcodePadding = 40;
  const barcodeBoxW = size - (barcodePadding * 2);
  const barcodeBoxH = 260;
  const barcodeBoxX = barcodePadding;
  const barcodeBoxY = barcodeYStart;

  ctx.fillStyle = '#ffffff';
  roundedRect(ctx, barcodeBoxX, barcodeBoxY, barcodeBoxW, barcodeBoxH, 20);
  ctx.fill();

  // Render barcode to fill the white box
  const barcodeInnerW = barcodeBoxW - 40;
  const barcodeInnerH = barcodeBoxH - 30;
  const barcodeCanvas = createCanvas(barcodeInnerW, barcodeInnerH);
  try {
    JsBarcode(barcodeCanvas, asdaBarcode, {
      format: 'CODE128',
      width: 3,
      height: barcodeInnerH - 50,
      displayValue: true,
      fontSize: 22,
      margin: 10,
      background: '#ffffff',
      lineColor: '#000000',
    });
  } catch {
    const bCtx = barcodeCanvas.getContext('2d');
    bCtx.fillStyle = '#000000';
    bCtx.font = '22px monospace';
    bCtx.textAlign = 'center';
    bCtx.fillText(asdaBarcode, barcodeCanvas.width / 2, barcodeCanvas.height / 2);
  }

  ctx.drawImage(barcodeCanvas, barcodeBoxX + 20, barcodeBoxY + 15);

  // --- Footer watermark ---
  ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.font = '18px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Matrix Methods', size / 2, size - 25);

  return canvas.toBuffer('image/png');
}

// --- Handle barcode generation (shared between /gen and modal) ---
async function handleBarcodeGeneration(interaction, productBarcode, priceStr) {
  const priceFloat = parseFloat(priceStr);
  if (isNaN(priceFloat) || priceFloat < 0) {
    await interaction.editReply('❌ Invalid price entered.');
    return;
  }
  const priceInPence = Math.round(priceFloat * 100);

  // Generate barcode string
  const asdaBarcode = generateAsdaBarcode(productBarcode, priceInPence);

  // Fetch product info (name + image)
  const { name: productName, imageUrl } = await fetchProductInfo(productBarcode);

  // Render image
  const imageBuffer = await renderBarcodeImage(
    asdaBarcode,
    productName,
    priceFloat.toFixed(2),
    imageUrl
  );

  const attachment = new AttachmentBuilder(imageBuffer, {
    name: 'barcode.png',
  });

  // DM the user
  try {
    await interaction.user.send({ files: [attachment] });
    await interaction.editReply('✅ Barcode sent to your DMs!');
  } catch {
    await interaction.editReply(
      '❌ Could not send DM. Please make sure your DMs are open.'
    );
  }
}

// --- Event: ready ---
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// --- Event: interactions ---
client.on('interactionCreate', async (interaction) => {
  // --- Slash commands ---
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    // --- Admin-only commands ---
    if (['panel', 'grant', 'revoke', 'allow', 'disallow'].includes(commandName)) {
      if (!isAdmin(interaction.user.id)) {
        await interaction.reply({
          content: '❌ You do not have permission to use this command.',
          ephemeral: true,
        });
        return;
      }
    }

    if (commandName === 'panel') {
      const embed = new EmbedBuilder()
        .setTitle('MATRIX METHODS — Asda Generator')
        .setDescription(
          'Generate reduced Asda barcodes. Click below to get started.'
        )
        .setColor(0x10b981);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('generate_barcode')
          .setLabel('🛒 Generate Barcode')
          .setStyle(ButtonStyle.Success)
      );

      await interaction.reply({ content: 'Panel posted!', ephemeral: true });
      await interaction.channel.send({ embeds: [embed], components: [row] });
      return;
    }

    if (commandName === 'grant') {
      const user = interaction.options.getUser('user');
      const member = await interaction.guild.members.fetch(user.id);
      await member.roles.add(ROLE_ID);
      await interaction.reply(`✅ Access granted to ${user}`);
      return;
    }

    if (commandName === 'revoke') {
      const user = interaction.options.getUser('user');
      const member = await interaction.guild.members.fetch(user.id);
      await member.roles.remove(ROLE_ID);
      await interaction.reply(`✅ Access revoked from ${user}`);
      return;
    }

    if (commandName === 'allow') {
      const user = interaction.options.getUser('user');
      const admins = loadAdmins();
      if (admins.includes(user.id)) {
        await interaction.reply({ content: `⚠️ ${user} is already an admin.`, ephemeral: true });
        return;
      }
      admins.push(user.id);
      saveAdmins(admins);
      await interaction.reply(`✅ ${user} has been added as a bot admin.`);
      return;
    }

    if (commandName === 'disallow') {
      const user = interaction.options.getUser('user');
      const admins = loadAdmins();
      if (!admins.includes(user.id)) {
        await interaction.reply({ content: `⚠️ ${user} is not an admin.`, ephemeral: true });
        return;
      }
      // Prevent removing the owner
      if (user.id === '1219810978708066365') {
        await interaction.reply({ content: '❌ Cannot remove the primary owner.', ephemeral: true });
        return;
      }
      const updated = admins.filter((id) => id !== user.id);
      saveAdmins(updated);
      await interaction.reply(`✅ ${user} has been removed as a bot admin.`);
      return;
    }

    if (commandName === 'gen') {
      // Check role
      const member = interaction.member;
      if (!member.roles.cache.has(ROLE_ID) && !isAdmin(interaction.user.id)) {
        await interaction.reply({
          content: "You don't have access to this generator.",
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      const productBarcode = interaction.options.getString('barcode');
      const priceStr = interaction.options.getString('price');
      await handleBarcodeGeneration(interaction, productBarcode, priceStr);
      return;
    }
  }

  // --- Button click ---
  if (interaction.isButton() && interaction.customId === 'generate_barcode') {
    // Check role
    const member = interaction.member;
    if (!member.roles.cache.has(ROLE_ID) && !isAdmin(interaction.user.id)) {
      await interaction.reply({
        content: "You don't have access to this generator.",
        ephemeral: true,
      });
      return;
    }

    // Show modal
    const modal = new ModalBuilder()
      .setCustomId('barcode_modal')
      .setTitle('Asda Barcode Generator');

    const barcodeInput = new TextInputBuilder()
      .setCustomId('product_barcode')
      .setLabel('Product Barcode')
      .setPlaceholder('Enter 8-13 digit barcode')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(8)
      .setMaxLength(13);

    const priceInput = new TextInputBuilder()
      .setCustomId('price')
      .setLabel('Price (£)')
      .setPlaceholder('e.g. 0.10')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(barcodeInput),
      new ActionRowBuilder().addComponents(priceInput)
    );

    await interaction.showModal(modal);
    return;
  }

  // --- Modal submit ---
  if (interaction.isModalSubmit() && interaction.customId === 'barcode_modal') {
    await interaction.deferReply({ ephemeral: true });

    const productBarcode = interaction.fields.getTextInputValue('product_barcode');
    const priceStr = interaction.fields.getTextInputValue('price');
    await handleBarcodeGeneration(interaction, productBarcode, priceStr);
  }
});

// --- Start ---
(async () => {
  await registerCommands();
  client.login(TOKEN);
})();
