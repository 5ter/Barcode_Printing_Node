module.exports = {
  apps : [
    // --- Application 1: Main API on Port 3000 ---
    {
      name: "Printer-api",
      script: "./apps.js", // Path to the entry file for App 1
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 3003 // Unique Port for App 1
      }
    },
    // --- Application 2: Worker Process on Port 3001 ---
    {
      name: "Upload-excel-service",
      script: "./app_excel.js", // Path to the entry file for App 2
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 3005 // Unique Port for App 2
      }
    },
    // --- Application 3: Admin Dashboard on Port 3002 ---
    {
      name: "admin-dashboard",
      script: "./app_download.js", // Path to the entry file for App 3
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 3006 // Unique Port for App 3
      }
    },
        // --- Application 4: CCD Server ---
    {
      name: "CCD_Server",
      script: "../wenbin/CCD_Stamping_dataserver/ccdstampingserver.js", // Path to the entry file for App 3
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 4005 // Unique Port for App 4
      }
    },
            // --- Application 5: CCD Download Server ---
    // {
    //   name: "CCD_Download_server",
    //   cwd: "C:/wenbin/CCD_Stamping_dataserver",
    //   script: "download.js", // Path to the entry file for App 3
    //   instances: 1,
    //   exec_mode: "fork",
    //   env: {
    //     NODE_ENV: "production",
    //     PORT: 4030 // Unique Port for App 4
    //   }
    // },

    {
      name: "Tray_Packing_Server",
      cwd: "C:/CCD_Checklist",
      script: "server.js", // Path to the entry file for App 3
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 3168 // Unique Port for App 4
      }
    },

    {
      name: "SO Splitting",
      cwd: "C:/SO Split",
      script: "Server.js", // Path to the entry file for App 3
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 1840 // Unique Port for App 4
      }
    },

    {
      name: "QC TV Display",
      cwd: "D:/QC tv Display board",
      script: "server.js", // Path to the entry file for App 3
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 4050 // Unique Port for App 4
      }
    },
    
    {
      name: "CCD_middleware",
      cwd: "C:/wenbin/CCD_Stamping_dataserver",
      script: "test_mid_cache.js", 
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 3235 
      }
    }
    ,
    
    {
      name: "CCD_server",
      cwd: "C:/wenbin/CCD_Stamping_dataserver",
      script: "test_ccdstampingserver.js", 
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 3233
      }
    },
    
    {
      name: 'warehouse-label',
      cwd:"D:/warehouse label/kitting_stock_count_system",
      script: './bin/www',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      node_args: ['--env-file=.env'],
      env:
      {
        NODE_ENV: 'production',
        PORT: 3333
      }
    }
  ]
};