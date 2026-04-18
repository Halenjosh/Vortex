const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron")
const os = require("os")
const pty = require("node-pty")

let win

function createWindow() {
    win = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    })

    win.loadFile("index.html")

    // Initialize node-pty
    const shell = process.env[os.platform() === "win32" ? "COMSPEC" : "SHELL"] || "zsh";
    const ptyProcess = pty.spawn(shell, [], {
        name: "xterm-color",
        cols: 80,
        rows: 30,
        cwd: process.env.HOME,
        env: process.env
    })

    // Listen for output from the shell and send it to the renderer
    ptyProcess.onData((data) => {
        win.webContents.send("terminal-incData", data)
    })

    // Listen for input from the renderer and write it to the shell
    ipcMain.on("terminal-intoData", (event, data) => {
        ptyProcess.write(data)
    })
}

app.whenReady().then(() => {

    createWindow()

    const template = [

        {
            label: "Electron",
            submenu: [
                { role: "about" },
                { type: "separator" },
                { role: "quit" }
            ]
        },

        {
            label: "File",
            submenu: [
                {
                    label: "Open Folder",
                    click: async () => {
                        handleOpenFolder();
                    }
                }
            ]
        },

        {
            label: "Edit",
            submenu: [
                { role: "undo" },
                { role: "redo" },
                { type: "separator" },
                { role: "cut" },
                { role: "copy" },
                { role: "paste" }
            ]
        },

        {
            label: "View",
            submenu: [
                { role: "reload" },
                { role: "toggleDevTools" }
            ]
        }

    ]

    const menu = Menu.buildFromTemplate(template)

    Menu.setApplicationMenu(menu)

})

ipcMain.handle("read-file", async (event, filePath) => {
    const fs = require("fs")
    return fs.promises.readFile(filePath, "utf-8")
})

ipcMain.handle("save-file", async (event, data) => {
    const fs = require("fs")
    await fs.promises.writeFile(data.path, data.content, "utf-8")
    return true
})

// Centralized Open Folder Logic
async function handleOpenFolder() {
    const fs = require("fs")
    const path = require("path")

    const result = await dialog.showOpenDialog({
        properties: ["openDirectory"]
    })

    if (!result.canceled) {
        const folder = result.filePaths[0]

        function readDirRecursive(dir) {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            const result = [];
            for (const entry of entries) {
                if (entry.name.startsWith(".")) continue;
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    result.push({
                        name: entry.name,
                        path: fullPath,
                        isDirectory: true,
                        children: readDirRecursive(fullPath)
                    });
                } else {
                    result.push({
                        name: entry.name,
                        path: fullPath,
                        isDirectory: false
                    });
                }
            }
            return result;
        }

        const files = readDirRecursive(folder)
        if (win) win.webContents.send("folder-opened", files, folder)
    }
}

// Ensure renderer process can trigger the dialog
ipcMain.on("open-folder", () => {
    handleOpenFolder();
});

ipcMain.handle("search-files", async (event, query, files) => {
    const fs = require("fs")
    const results = []

    if (!query || query.trim() === "") return results;

    const promises = files.map(async (file) => {
        // Skip hidden files, .git, and node_modules explicitly
        if (file.path.includes('/.git/') || file.path.includes('/node_modules/') || file.name.startsWith('.')) return;

        try {
            const content = await fs.promises.readFile(file.path, "utf-8")
            const lines = content.split('\n')

            lines.forEach((line, index) => {
                if (line.toLowerCase().includes(query.toLowerCase())) {
                    results.push({
                        name: file.name,
                        path: file.path,
                        line: index + 1,
                        text: line.trim()
                    })
                }
            })
        } catch (error) {
            // Silently ignore files that can't be read (e.g. binaries)
        }
    })

    await Promise.all(promises)
    return results
})

ipcMain.handle("git-status", async (event, folderPath) => {
    const { exec } = require("child_process")
    const util = require("util")
    const execPromise = util.promisify(exec)

    try {
        await execPromise("git rev-parse --is-inside-work-tree", { cwd: folderPath })
    } catch {
        return "not-git-repo"
    }

    try {
        const { stdout } = await execPromise("git status --porcelain", { cwd: folderPath })
        if (!stdout) return []

        const lines = stdout.split("\n").filter(line => line.trim() !== "")
        return lines.map(line => ({
            status: line.substring(0, 2).trim(),
            file: line.substring(3).trim()
        }))
    } catch (err) {
        return []
    }
})

ipcMain.handle("git-commit", async (event, folderPath, message) => {
    const { exec } = require("child_process")
    const util = require("util")
    const execPromise = util.promisify(exec)

    try {
        await execPromise("git add -A", { cwd: folderPath })
        await execPromise(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: folderPath })
        return true
    } catch (err) {
        console.error("Commit failed:", err)
        return false
    }
})

ipcMain.handle("ai-query", async (event, payload) => {
    const { question, fileContent } = payload;
    try {
        const response = await fetch("http://127.0.0.1:11434/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "deepseek-coder:1.3b",
                stream: false,
                prompt: `You are an AI coding assistant.\n\nUser question:\n${question}\n\nCurrent file:\n${fileContent || "No active file opened."}`
            })
        });

        const data = await response.json();
        return data.response;
    } catch (error) {
        return "⚠️ Error: Unable to connect to local Ollama instance at http://127.0.0.1:11434. Please ensure Ollama is running with the 'deepseek-coder:1.3b' model.";
    }
})

ipcMain.handle("ai-edit", async (event, payload) => {
    const { code, instruction } = payload;
    try {
        const response = await fetch("http://127.0.0.1:11434/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "deepseek-coder:1.3b",
                stream: false,
                prompt: `Modify the following code based on the instruction. Return ONLY the modified code without markdown blocks or explanations.\n\nInstruction: ${instruction}\n\nCode:\n${code}`
            })
        });

        const data = await response.json();
        let result = data.response.trim();

        // Deepseek sometimes ignores the "No markdown" prompt. Extract the raw block if present.
        const codeBlockRegex = /```[\w]*\n([\s\S]*?)```/g;
        let finalCode = "";
        let match;
        while ((match = codeBlockRegex.exec(result)) !== null) {
            finalCode += match[1] + "\n";
        }

        if (finalCode) {
            result = finalCode.trim();
        } else {
            // Strip any trailing standalone markdown ticks that missed the regex
            result = result.replace(/^```[\w]*\n?/g, '').replace(/```$/g, '').trim();
        }

        return result;
    } catch (error) {
        throw new Error("⚠️ Formatter Error: Unable to connect to local Ollama instance.");
    }
})

ipcMain.handle("ai-autocomplete", async (event, payload) => {
    const { prefix } = payload;
    try {
        const response = await fetch("http://127.0.0.1:11434/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "deepseek-coder:1.3b",
                stream: false,
                prompt: "Continue the following code. Return ONLY the next logical lines of code. Do not explain.\n\n" + prefix,
                options: {
                    num_predict: 50 // Keep response short (few lines only)
                }
            })
        });

        const data = await response.json();
        let result = data.response;
        
        // Sometimes models return formatting backticks, clean them up for raw code injection
        result = result.replace(/^```[\w]*\n?/g, '').replace(/```$/g, '');
        
        return result;
    } catch (error) {
        // Return empty string on failure so it fails silently for autocomplete
        return "";
    }
})

ipcMain.handle("agent-query", async (event, payload) => {
    const { user_input } = payload;
    try {
        const response = await fetch("http://127.0.0.1:11434/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "deepseek-coder:1.3b",
                stream: false,
                prompt: `You are an autonomous coding agent.\n\nYou can perform actions using the following tools:\n- read_file(path)\n- write_file(path, content)\n- create_file(path, content)\n- run_terminal(command)\n\nReturn a JSON array of actions to execute.\n\nEach action must be in this format:\n{\n  "type": "read_file" | "write_file" | "create_file" | "run_terminal",\n  "path": "...",\n  "content": "...",\n  "command": "..."\n}\n\nUser request:\n${user_input}`
            })
        });

        const data = await response.json();
        return data.response;
    } catch (error) {
        return `[{"type": "error", "content": "Unable to connect to local Ollama instance."}]`;
    }
});

ipcMain.handle("agent-read-file", async (event, filePath) => {
    const fs = require("fs")
    try {
        return await fs.promises.readFile(filePath, "utf-8")
    } catch (err) {
        return `Error: ${err.message}`
    }
})

ipcMain.handle("agent-write-file", async (event, payload) => {
    const fs = require("fs")
    try {
        await fs.promises.writeFile(payload.path, payload.content, "utf-8")
        return { success: true }
    } catch (err) {
        return { success: false, error: err.message }
    }
})

ipcMain.handle("agent-create-file", async (event, payload) => {
    const fs = require("fs")
    try {
        await fs.promises.writeFile(payload.path, payload.content, "utf-8")
        return { success: true }
    } catch (err) {
        return { success: false, error: err.message }
    }
})

ipcMain.handle("agent-run-command", async (event, payload) => {
    const { exec } = require("child_process")
    const util = require("util")
    const execPromise = util.promisify(exec)

    try {
        // Run with active folder context
        const { stdout, stderr } = await execPromise(payload.command, { cwd: payload.folderPath || process.cwd() })
        return { success: true, stdout, stderr }
    } catch (err) {
        return { success: false, error: err.message, stderr: err.stderr }
    }
})