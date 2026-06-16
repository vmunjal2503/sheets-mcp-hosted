// PM2 ecosystem config — copy to ecosystem.config.cjs on the EC2 box.
//
//   cp deploy/ecosystem.config.example.cjs deploy/ecosystem.config.cjs
//   pm2 start deploy/ecosystem.config.cjs
//   pm2 save
//
// Logs land in /home/mernapp/logs/sheets-mcp-{out,err}.log

module.exports = {
  apps: [
    {
      name: "sheets-mcp",
      cwd: "/home/mernapp/sheets-mcp-hosted",
      script: "dist/index.js",
      node_args: "",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
      out_file: "/home/mernapp/logs/sheets-mcp-out.log",
      error_file: "/home/mernapp/logs/sheets-mcp-err.log",
      merge_logs: true,
      max_memory_restart: "400M",
      autorestart: true,
      watch: false,
    },
  ],
};
