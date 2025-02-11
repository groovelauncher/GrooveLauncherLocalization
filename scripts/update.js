import axios from 'axios';
import { Octokit } from "@octokit/rest";
import dotenv from 'dotenv';
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// If you need __dirname in ES modules:
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const CROWDIN_API_KEY = process.env.CROWDIN_API_KEY;
const CROWDIN_PROJECT_ID = 737627;
const GITHUB_TOKEN = process.env.TOKEN;
const GITHUB_OWNER = "groovelauncher";
const GITHUB_REPO = "GrooveLauncherLocalization";
const GITHUB_BRANCH = 'nightly';
// Create a temporary directory for extracted files
const tempDir = path.join(__dirname, 'translations-temp');

const crowdinApi = axios.create({
    baseURL: 'https://api.crowdin.com/api/v2',
    headers: {
        Authorization: `Bearer ${CROWDIN_API_KEY}`
    }
});

const octokit = new Octokit({
    auth: GITHUB_TOKEN
});

async function retry(fn, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i === retries - 1) throw err;
            console.log(`Attempt ${i + 1} failed, retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

async function downloadTranslations() {
    try {
        console.log('Building translations...');
        const buildResponse = await crowdinApi.post(`/projects/${CROWDIN_PROJECT_ID}/translations/builds`);
        const buildId = buildResponse.data.data.id;

        console.log('Waiting for build to complete...');
        let buildStatus;
        do {
            const statusResponse = await crowdinApi.get(`/projects/${CROWDIN_PROJECT_ID}/translations/builds/${buildId}`);
            buildStatus = statusResponse.data.data.status;
            if (buildStatus !== 'finished') {
                await new Promise(resolve => setTimeout(resolve, 5000)); // Poll every 5 seconds
            }
        } while (buildStatus !== 'finished');

        console.log('Downloading translations...');
        const downloadResponse = await crowdinApi.get(`/projects/${CROWDIN_PROJECT_ID}/translations/builds/${buildId}/download`);
        const translationsUrl = downloadResponse.data.data.url;

        // Download the ZIP file
        const translationsZip = await axios.get(translationsUrl, { responseType: 'arraybuffer' });

        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir);
        }

        // Save and extract the ZIP file
        const zipPath = path.join(tempDir, 'translations.zip');
        fs.writeFileSync(zipPath, translationsZip.data);

        const zip = new AdmZip(zipPath);
        console.log('Extracting ZIP file...');
        zip.extractAllTo(tempDir, true);

        // Read the extracted files
        const extractedFiles = fs.readdirSync(tempDir);
        console.log('Extracted files:', extractedFiles);

        return true
    } catch (error) {
        console.error('Error downloading translations:', error);
        throw error;
    }
}

async function uploadToGithub(localPath, remotePath) {
    try {
        console.log('Checking for changes...');

        // Check if directory exists
        if (!fs.existsSync(localPath)) {
            throw new Error(`Local path ${localPath} does not exist`);
        }

        // Check if the nightly branch exists, if not create it
        const branches = await octokit.repos.listBranches({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO
        });

        const branchExists = branches.data.some(branch => branch.name === GITHUB_BRANCH);
        if (!branchExists) {
            console.log(`Branch ${GITHUB_BRANCH} does not exist. Creating it...`);
            const { data: ref } = await octokit.git.getRef({
                owner: GITHUB_OWNER,
                repo: GITHUB_REPO,
                ref: 'heads/main' // Assuming 'main' is your default branch
            });

            await octokit.git.createRef({
                owner: GITHUB_OWNER,
                repo: GITHUB_REPO,
                ref: `refs/heads/${GITHUB_BRANCH}`,
                sha: ref.object.sha
            });
            console.log(`Branch ${GITHUB_BRANCH} created successfully.`);
        }

        // Get all directories in localPath
        const directories = fs.readdirSync(localPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

        // Get all files from all directories
        const allFiles = [];
        directories.forEach(dir => {
            const dirPath = path.join(localPath, dir);
            const files = fs.readdirSync(dirPath)
                .filter(file => file.endsWith('.json'))
                .map(file => ({
                    localPath: path.join(dirPath, file),
                    remotePath: path.posix.join(remotePath, dir, file)
                }));
            allFiles.push(...files);
        });

        // Initialize progress tracking variables
        let uploadedFiles = 0;
        const totalFiles = allFiles.length;

        // Get current tree contents
        const { data: ref } = await octokit.git.getRef({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            ref: `heads/${GITHUB_BRANCH}`
        });

        const { data: commitData } = await octokit.git.getCommit({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            commit_sha: ref.object.sha
        });

        // Get current tree with recursive=1 to get all files
        const { data: currentTree } = await octokit.git.getTree({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            tree_sha: commitData.tree.sha,
            recursive: 1
        });

        // Create map of current files
        const currentFiles = new Map();
        currentTree.tree.forEach(item => {
            if (item.type === 'blob') {
                currentFiles.set(item.path, item.sha);
            }
        });

        // Process files in batches
        const BATCH_SIZE = 10;
        const results = [];

        for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
            const batch = allFiles.slice(i, i + BATCH_SIZE);
            console.log(`Processing batch ${i / BATCH_SIZE + 1} of ${Math.ceil(allFiles.length / BATCH_SIZE)}`);

            const batchResults = await Promise.all(batch.map(async (file) => {
                if (!fs.existsSync(file.localPath)) {
                    console.warn(`Skipping non-existent file: ${file.localPath}`);
                    return null;
                }

                const content = fs.readFileSync(file.localPath, 'utf8');

                // Add retry logic to blob creation
                const { data } = await retry(async () => {
                    return await octokit.git.createBlob({
                        owner: GITHUB_OWNER,
                        repo: GITHUB_REPO,
                        content: content,
                        encoding: 'utf-8'
                    });
                }, 3, 2000);

                uploadedFiles++;
                console.log(`Progress: ${uploadedFiles}/${totalFiles} files (${Math.round(uploadedFiles / totalFiles * 100)}%)`);

                const currentSha = currentFiles.get(file.remotePath);
                if (!currentSha || currentSha !== data.sha) {
                    return {
                        path: file.remotePath,
                        mode: '100644',
                        type: 'blob',
                        sha: data.sha
                    };
                }
                return null;
            }));

            results.push(...batchResults);

            // Add a small delay between batches
            if (i + BATCH_SIZE < allFiles.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        // Filter out unchanged and null entries
        const changedBlobs = results.filter(blob => blob !== null);

        if (changedBlobs.length === 0) {
            console.log('No changes detected, skipping GitHub update');
            return;
        }

        console.log(`Uploading ${changedBlobs.length} changed files...`);

        // Create a new tree with changed blobs
        const { data: tree } = await octokit.git.createTree({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            base_tree: commitData.tree.sha,
            tree: changedBlobs
        });

        // Create a commit
        const { data: newCommit } = await octokit.git.createCommit({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            message: `[Crowdin] Sync translations - ${new Date().toISOString()}`,
            tree: tree.sha,
            parents: [ref.object.sha]
        });

        // Update the nightly branch reference
        await octokit.git.updateRef({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            ref: `heads/${GITHUB_BRANCH}`,
            sha: newCommit.sha
        });

        console.log('Files uploaded successfully to GitHub');
    } catch (error) {
        throw error;
        console.error('Error uploading to GitHub:', error.status);
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
}

async function cleanupTempDir() {
    try {
        if (fs.existsSync(tempDir)) {
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
    } catch (error) {
        console.error('Error cleaning up temporary directory:', error);
        // Continue execution even if cleanup fails
    }
}

async function syncTranslations() {
    try {
        console.log('Starting translation sync...');
        await cleanupTempDir();
        await downloadTranslations();
        await uploadToGithub(tempDir, 'languages');
        await cleanupTempDir();

        console.log('Translation sync completed successfully');
    } catch (error) {
        console.error('Translation sync failed:', error);
    }
}

// Initial sync
syncTranslations();