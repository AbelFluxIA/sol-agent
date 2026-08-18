module.exports = {
  apps: [
    {
      name: 'sol-agent',
      script: './dist/index.js',
      cwd: '/root/sol-agent',
      kill_timeout: 330000, // 5min30s — tempo para o Gemini terminar antes do SIGKILL
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
