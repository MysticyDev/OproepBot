const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, 
        StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, 
        TextInputStyle, PermissionFlagsBits } = require('discord.js');
const mongoose = require('mongoose');
const yaml = require('js-yaml');
const fs = require('fs');
const axios = require('axios');

const config = yaml.load(fs.readFileSync('./config.yml', 'utf8'));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const rateLimitSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  timestamp: { type: Date, default: Date.now }
});

let RateLimit;

async function verbindMetMongoose() {
  try {
    await mongoose.connect(config.mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('Verbonden met MongoDB via Mongoose');
    
    RateLimit = mongoose.model('RateLimit', rateLimitSchema);
  } catch (error) {
    console.error('Fout bij het verbinden met MongoDB:', error);
  }
}

client.once('ready', async () => {
  console.log(`Ingelogd als ${client.user.tag}`);
  await verbindMetMongoose();
});

client.on('ready', async () => {
  const commands = [
    {
      name: 'eenheidoproep',
      description: 'Start een nieuwe oproep voor eenheid',
      defaultMemberPermissions: PermissionFlagsBits.Administrator
    }
  ];

  try {
    await client.application.commands.set(commands);
    console.log('Commando\'s succesvol geregistreerd');
  } catch (error) {
    console.error('Fout bij het registreren van commando\'s:', error);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  if (interaction.commandName === 'eenheidoproep') {
    await verwerkeenheidOproep(interaction);
  }
});

async function verwerkeenheidOproep(interaction) {
  try {
    const doelKanaal = interaction.channel;
    
    const embed = new EmbedBuilder()
      .setTitle(config.menuTitle || 'eenheid Oproep')
      .setDescription(config.menuDescription || 'Selecteer een optie hieronder om je aan te melden voor een eenheid')
      .setColor(config.embedColor || '#5865F2')
      .setTimestamp();

    if (config.authorizedRoleIds && config.authorizedRoleIds.length > 0) {
      const rollenTekst = config.authorizedRoleIds.map(id => `<@&${id}>`).join(', ');
      embed.addFields({ name: 'Voor rollen', value: rollenTekst });
    }

    const selectOpties = config.dropdownOptions.map(optie => ({
      label: optie.label,
      value: optie.value
    }));

    const row = new ActionRowBuilder()
      .addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('eenheid_select')
          .setPlaceholder(config.dropdownPlaceholder || 'Kies een eenheid')
          .addOptions(selectOpties)
      );

    await doelKanaal.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: 'eenheid oproep is succesvol geplaatst!', ephemeral: true });
  } catch (error) {
    console.error('Fout in eenheidoproep:', error);
    await interaction.reply({
      content: 'Er is een fout opgetreden tijdens het plaatsen van de eenheid oproep.',
      ephemeral: true
    });
  }
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isStringSelectMenu() || interaction.customId !== 'eenheid_select') return;

  const heefteenheidRol = !config.authorizedRoleIds || config.authorizedRoleIds.length === 0 || 
    config.authorizedRoleIds.some(roleId => interaction.member.roles.cache.has(roleId));

  if (!heefteenheidRol) {
    return await interaction.reply({
      content: 'Je hebt geen toestemming om je aan te melden voor eenheid.',
      ephemeral: true
    });
  }

  const geselecteerdeOptie = config.dropdownOptions.find(optie => 
    optie.value === interaction.values[0]
  );

  if (!geselecteerdeOptie) return;

  const modal = new ModalBuilder()
    .setCustomId(`eenheid_modal_${geselecteerdeOptie.value}`)
    .setTitle(`Oproep: ${geselecteerdeOptie.label}`);

  const doelInput = new TextInputBuilder()
    .setCustomId('doel')
    .setLabel('Waarvoor je ze nodig hebt')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Beschrijf waarvoor je deze eenheid nodig hebt...')
    .setRequired(true)
    .setMaxLength(500);

  const locatieInput = new TextInputBuilder()
    .setCustomId('locatie')
    .setLabel('Waar')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Geef aan waar je deze eenheid nodig hebt...')
    .setRequired(true)
    .setMaxLength(200);

  const eersteActieRij = new ActionRowBuilder().addComponents(doelInput);
  const tweedeActieRij = new ActionRowBuilder().addComponents(locatieInput);
  
  modal.addComponents(eersteActieRij, tweedeActieRij);

  await interaction.showModal(modal);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isModalSubmit() || !interaction.customId.startsWith('eenheid_modal_')) return;

  try {
    const gebruikerId = interaction.user.id;
    const geselecteerdeWaarde = interaction.customId.replace('eenheid_modal_', '');
    const geselecteerdeOptie = config.dropdownOptions.find(optie => 
      optie.value === geselecteerdeWaarde
    );
    
    const rateLimiet = await controleerRateLimiet(gebruikerId);
    if (rateLimiet.limited) {
      return await interaction.reply({
        content: `Je hebt recent een oproep ingediend. Wacht nog ${rateLimiet.remainingTime} seconden voordat je opnieuw indient.`,
        ephemeral: true
      });
    }

    await opslaanRateLimiet(gebruikerId);
    
    const doel = interaction.fields.getTextInputValue('doel');
    const locatie = interaction.fields.getTextInputValue('locatie');

    const webhookUrl = config.webhooks[geselecteerdeWaarde];
    if (!webhookUrl) {
      return await interaction.reply({
        content: 'Fout: Webhook niet geconfigureerd voor deze optie.',
        ephemeral: true
      });
    }

    const rolIDS = config.notifyRoleIds && config.notifyRoleIds[geselecteerdeWaarde]
    ? config.notifyRoleIds[geselecteerdeWaarde]
    : [];
    
    let rolMentions = '';
    if (rolIDS.length > 0) {
        rolMentions = rolIDS.map(id => `<@&${id}>`).join(' ');
    }

    let contentMentions = '';
    if (rolIDS.length > 0) {
        contentMentions = rolIDS.map(id => `<@&${id}>`).join(' ');
    }

    const embed = {
      title: `Nieuwe Oproep: ${geselecteerdeOptie.label}`,
      description: `**Van:**\n<@${interaction.user.id}>\n\n**Postcode / Locatie:\n**${locatie}\n\n**Situatie:**\n${doel}`,
      color: parseInt(config.embedColor?.replace('#', '') || '5865F2', 16),
      timestamp: new Date().toISOString(),
      footer: { text: `Gebruiker ID: ${interaction.user.id}` }
    };

    await verstuurNaarWebhook(webhookUrl, {
      content: rolMentions, 
      username: client.user.username,
      avatar_url: client.user.displayAvatarURL(),
      embeds: [embed],
      allowed_mentions: { parse: ["roles"] } 
    });

    await interaction.reply({
      content: 'Je oproep voor deze eenheid is succesvol ingediend!',
      ephemeral: true
    });
  } catch (error) {
    console.error('Fout bij het verwerken van eenheid modal:', error);
    await interaction.reply({
      content: 'Er is een fout opgetreden bij het verwerken van je oproep.',
      ephemeral: true
    });
  }
});

async function verstuurNaarWebhook(webhookUrl, data) {
  try {
    const response = await axios.post(webhookUrl, data, {
      headers: {
        'Content-Type': 'application/json',
      }
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    return true;
  } catch (error) {
    console.error('Fout bij het versturen naar webhook:', error);
    throw error;
  }
}

async function controleerRateLimiet(gebruikerId) {
  try {
    const gebruikerLimiet = await RateLimit.findOne({ userId: gebruikerId });
    
    if (!gebruikerLimiet) {
      return { limited: false };
    }

    const huidigetijd = Date.now();
    const tijdsverschil = Math.floor((huidigetijd - gebruikerLimiet.timestamp) / 1000);
    const afkoeltijd = 120; 
    
    if (tijdsverschil < afkoeltijd) {
      return {
        limited: true,
        remainingTime: afkoeltijd - tijdsverschil
      };
    }
    
    return { limited: false };
  } catch (error) {
    console.error('Fout bij het controleren van rate limiet:', error);
    return { limited: false }; 
  }
}


async function opslaanRateLimiet(gebruikerId) {
  try {
    await RateLimit.findOneAndUpdate(
      { userId: gebruikerId },
      { userId: gebruikerId, timestamp: Date.now() },
      { upsert: true, new: true }
    );
  } catch (error) {
    console.error('Fout bij het opslaan van rate limiet:', error);
  }
}

client.login(config.token);
