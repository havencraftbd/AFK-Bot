const mineflayer = require('mineflayer')
const autoAuth = require('mineflayer-auto-auth')

const bot = mineflayer.createBot({
  host: 'mc.havencraft.pro',
  port: 25666,
  username: 'Junseo_Oren',
  version: false,

  plugins: {
    autoAuth: autoAuth
  },

  autoAuth: {
    password: '998877'
  }
})

bot.once('spawn', () => {
  console.log('Bot joined server!')

  setInterval(() => {
    bot.setControlState('jump', false)

    setTimeout(() => {
      bot.setControlState('jump', false)
    }, 500)

  }, 30000)
})

bot.on('chat', (username, message) => {
  console.log(`[CHAT] ${username}: ${message}`)
})

bot.on('kicked', console.log)
bot.on('error', console.log)
