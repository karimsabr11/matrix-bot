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
    )
    .addStringOption((opt) =>
      opt
        .setName('original_price')
        .setDescription('Original price in £ (e.g. 5.10)')
        .setRequired(false)
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

// --- Fetch product info (try OpenFoodFacts first, then Asda) ---
async function fetchProductInfo(barcode) {
  // Try OpenFoodFacts (reliable for barcode lookups, has images and price)
  try {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`
    );
    if (res.ok) {
      const data = await res.json();
      if (data?.product?.product_name) {
        return {
          name: data.product.product_name,
          imageUrl: data.product.image_front_url || data.product.image_url || null,
          originalPrice: null, // OpenFoodFacts doesn't have price
        };
      }
    }
  } catch {}

  // Try Asda grocery search as fallback
  try {
    const res = await fetch(
      `https://groceries.asda.com/api/items/search?keyword=${barcode}&page=1&page_size=1`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
      }
    );
    if (res.ok) {
      const data = await res.json();
      const item = data?.data?.tempo_cms_content?.zone2?.[0]?.fitment?.items?.[0]
        || data?.data?.items?.[0];
      if (item) {
        return {
          name: item.item_name || item.name || null,
          imageUrl: item.images?.large || item.image || null,
          originalPrice: item.price?.price_info?.price || item.price || null,
        };
      }
    }
  } catch {}

  return { name: null, imageUrl: null, originalPrice: null };
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

// --- Render barcode image ---
async function renderBarcodeImage(asdaBarcode, productName, price, productImageUrl, originalPrice) {
  const width = 800;
  const height = 1100;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Dark background
  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(0, 0, width, height);

  let currentY = 40;

  // --- Product image ---
  if (productImageUrl) {
    const productImg = await fetchImage(productImageUrl);
    if (productImg) {
      const imgSize = 300;
      const imgX = (width - imgSize) / 2;
      const imgY = currentY;

      // White box behind image
      ctx.fillStyle = '#ffffff';
      roundedRect(ctx, imgX - 20, imgY - 20, imgSize + 40, imgSize + 40, 16);
      ctx.fill();

      // Draw product image
      const scale = Math.min(imgSize / productImg.width, imgSize / productImg.height);
      const drawW = productImg.width * scale;
      const drawH = productImg.height * scale;
      const drawX = imgX + (imgSize - drawW) / 2;
      const drawY = imgY + (imgSize - drawH) / 2;
      ctx.drawImage(productImg, drawX, drawY, drawW, drawH);

      currentY = imgY + imgSize + 50;
    }
  }

  // --- Product name (centered manually) ---
  const displayName = productName || 'Unknown Product';
  ctx.font = '34px sans-serif';
  ctx.fillStyle = '#ffffff';
  let nameMetrics = ctx.measureText(displayName);
  if (nameMetrics.width > width - 80) {
    ctx.font = '26px sans-serif';
    nameMetrics = ctx.measureText(displayName);
  }
  const nameX = (width - nameMetrics.width) / 2;
  ctx.fillText(displayName, nameX, currentY + 30);
  currentY += 70;

  // --- "WAS £X.XX" with strikethrough (red, centered) ---
  if (originalPrice) {
    const wasText = `WAS £${originalPrice}`;
    ctx.font = '26px sans-serif';
    ctx.fillStyle = '#ef4444';
    const wasMetrics = ctx.measureText(wasText);
    const wasX = (width - wasMetrics.width) / 2;
    ctx.fillText(wasText, wasX, currentY + 22);
    // Strikethrough
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(wasX, currentY + 15);
    ctx.lineTo(wasX + wasMetrics.width, currentY + 15);
    ctx.stroke();
    currentY += 55;
  }

  // --- New price in yellow box (centered) ---
  const priceText = `£${price}`;
  ctx.font = 'bold 56px sans-serif';
  const priceMetrics = ctx.measureText(priceText);
  const pBoxW = priceMetrics.width + 50;
  const pBoxH = 80;
  const pBoxX = (width - pBoxW) / 2;
  const pBoxY = currentY;

  ctx.fillStyle = '#f5c518';
  roundedRect(ctx, pBoxX, pBoxY, pBoxW, pBoxH, 12);
  ctx.fill();

  // Price text centered in yellow box
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 56px sans-serif';
  const priceX = (width - priceMetrics.width) / 2;
  ctx.fillText(priceText, priceX, pBoxY + 58);
  currentY = pBoxY + pBoxH + 40;

  // --- Barcode centered and filling width ---
  const barcodeW = width - 60;
  const barcodeH = height - currentY - 20;
  const barcodeCanvas = createCanvas(barcodeW, Math.max(barcodeH, 120));

  try {
    JsBarcode(barcodeCanvas, asdaBarcode, {
      format: 'CODE128',
      width: 3,
      height: Math.max(barcodeH - 40, 80),
      displayValue: true,
      fontSize: 20,
      margin: 0,
      background: 'transparent',
      lineColor: '#ffffff',
    });
  } catch {
    const bCtx = barcodeCanvas.getContext('2d');
    bCtx.fillStyle = '#ffffff';
    bCtx.font = '20px monospace';
    bCtx.fillText(asdaBarcode, 10, barcodeCanvas.height / 2);
  }

  // Center the barcode
  const barcodeX = (width - barcodeW) / 2;
  ctx.drawImage(barcodeCanvas, barcodeX, currentY);

  return canvas.toBuffer('image/png');
}

// --- Handle barcode generation (shared between /gen and modal) ---
async function handleBarcodeGeneration(interaction, productBarcode, priceStr, userOriginalPrice) {
  const priceFloat = parseFloat(priceStr);
  if (isNaN(priceFloat) || priceFloat < 0) {
    await interaction.editReply('❌ Invalid price entered.');
    return;
  }
  const priceInPence = Math.round(priceFloat * 100);

  // Generate barcode string
  const asdaBarcode = generateAsdaBarcode(productBarcode, priceInPence);

  // Fetch product info (name + image + original price)
  const { name: productName, imageUrl, originalPrice: fetchedPrice } = await fetchProductInfo(productBarcode);

  // Use user-provided original price if given, otherwise use fetched one
  const originalPrice = userOriginalPrice || fetchedPrice || null;

  // Render image
  const imageBuffer = await renderBarcodeImage(
    asdaBarcode,
    productName,
    priceFloat.toFixed(2),
    imageUrl,
    originalPrice
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
      const ogPriceStr = interaction.options.getString('original_price') || null;
      await handleBarcodeGeneration(interaction, productBarcode, priceStr, ogPriceStr);
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

    const ogPriceInput = new TextInputBuilder()
      .setCustomId('original_price')
      .setLabel('Original Price (£) - optional')
      .setPlaceholder('e.g. 5.10')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(barcodeInput),
      new ActionRowBuilder().addComponents(priceInput),
      new ActionRowBuilder().addComponents(ogPriceInput)
    );

    await interaction.showModal(modal);
    return;
  }

  // --- Modal submit ---
  if (interaction.isModalSubmit() && interaction.customId === 'barcode_modal') {
    await interaction.deferReply({ ephemeral: true });

    const productBarcode = interaction.fields.getTextInputValue('product_barcode');
    const priceStr = interaction.fields.getTextInputValue('price');
    const ogPriceStr = interaction.fields.getTextInputValue('original_price') || null;
    await handleBarcodeGeneration(interaction, productBarcode, priceStr, ogPriceStr);
  }
});

// --- Start ---
(async () => {
  await registerCommands();
  client.login(TOKEN);
})();
