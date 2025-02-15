// Necessary packages
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const normalizePath = require('normalize-path');
const isBinaryFileSync = require('isbinaryfile').isBinaryFileSync;
const slug = require('./../../helpers/slug');
const FTP = require('./ftp.js');
const SFTP = require('./sftp.js');
const S3 = require('./s3.js');
const Git = require('./git.js');
const GithubPages = require('./github-pages.js');
const GitlabPages = require('./gitlab-pages.js');
const Netlify = require('./netlify.js');
const GoogleCloud = require('./google-cloud.js');
const ManualDeployment = require('./manual.js');

/**
 *
 * Class used to upload files to:
 *
 * (S)FTP(S),
 * S3 server,
 * Git
 * Github Pages (deprecated),
 * Gitlab Pages (deprecated),
 * Netlify,
 * Google Cloud,
 * Manually
 *
 */
class Deployment {
    /**
     * Constructor
     *
     * @param appDir
     * @param sitesDir
     * @param siteConfig
     */
    constructor(appDir, sitesDir, siteConfig) {
        this.appDir = appDir;
        this.siteConfig = siteConfig;
        this.siteName = this.siteConfig.name;
        this.sitesDir = sitesDir;
        this.progressOfDeleting = 0;
        this.progressOfUploading = 0;
        this.client = false;
        this.filesToRemove = [];
        this.filesToUpload = [];
        this.operationsCounter = 0;
        this.syncRevision = crypto.randomUUID();
    }

    /**
     * Tests connection
     *
     * @param app
     * @param deploymentConfig
     * @param siteName
     */
    testConnection(app, deploymentConfig, siteName, uuid) {
        let connection = false;

        switch(deploymentConfig.protocol) {
            case 'sftp':
            case 'sftp+key':        connection = new SFTP();                        break;
            case 's3':              connection = new S3();                          break;
            case 'netlify':         connection = new Netlify();                     break;
            case 'google-cloud':    connection = new GoogleCloud();                 break;
            case 'git':             connection = new Git();                         break;
            case 'github-pages':    connection = new GithubPages(deploymentConfig); break;
            case 'gitlab-pages':    connection = new GitlabPages();                 break;
            default:                connection = new FTP();                         break;
        }

        if (connection) {
            connection.testConnection(app, deploymentConfig, siteName, uuid).then(() => true);
        }
    }

    /**
     * Inits connection
     */
    async initSession() {
        switch(this.siteConfig.deployment.protocol) {
            case 'sftp':
            case 'sftp+key':        this.client = new SFTP(this);               break;
            case 's3':              this.client = new S3(this);                 break;
            case 'git':             this.client = new Git(this);                break;
            case 'github-pages':    this.client = new GithubPages(this);        break;
            case 'gitlab-pages':    this.client = new GitlabPages(this);        break;
            case 'netlify':         this.client = new Netlify(this);            break;
            case 'google-cloud':    this.client = new GoogleCloud(this);        break;
            case 'manual':          this.client = new ManualDeployment(this);   break;
            default:                this.client = new FTP(this);                break;
        }

        await this.client.initConnection();
    }

    /**
     * Set input directory on local machine
     */
    setInput() {
        // Set the output dir as a source of the files to upload
        let basePath = path.join(this.sitesDir, this.siteName);
        this.inputDir = path.join(basePath, 'output');
        this.configDir = path.join(this.sitesDir, this.siteName, 'input', 'config');
    }

    /**
     * Sets output directory on the server
     */
    setOutput(useEmpty = false) {
        if(useEmpty) {
            this.outputDir = '';
        } else {
            this.outputDir = this.siteConfig.deployment.path;
        }
    }

    /**
     * Prepares list of local files
     */
    prepareLocalFilesList () {
        let tempFileList = this.readDirRecursiveSync(this.inputDir);
        let fileList = [];

        for (let filePath of tempFileList) {
            if (filePath === '.git') {
                continue;
            }

            if (filePath === '.htaccess' || filePath === '_redirects') {
                let excludedProtocols = ['s3', 'github-pages', 'google-cloud', 'netlify'];

                if (excludedProtocols.indexOf(this.siteConfig.deployment.protocol) === -1) {
                    fileList.push({
                        path: filePath,
                        type: 'file',
                        md5: crypto.createHash('md5').update(fs.readFileSync(path.join(this.inputDir, filePath))).digest('hex')
                    });
                }

                continue;
            }

            // Put directory
            if (fs.lstatSync(path.join(this.inputDir, filePath)).isDirectory()) {
                if (filePath.indexOf('/') === 0) {
                    filePath = filePath.substr(1);
                }

                if (
                    this.siteConfig.deployment.protocol !== 'google-cloud' &&
                    this.siteConfig.deployment.protocol !== 'gitlab-pages'
                ) {
                    fileList.push({
                        path: filePath,
                        type: 'directory',
                        md5: false
                    });
                }

                continue;
            }

            // Put file
            let fileMD5 = false;

            if (isBinaryFileSync(path.join(this.inputDir, filePath))) {
                let stats = fs.statSync(path.join(this.inputDir, filePath));
                // below operations are required for backward-compatibility with previously used md5 module
                // it differently handled integer values
                let fileSizePrepared = Buffer.from((stats.size).toString().split(''));
                fileMD5 = crypto.createHash('md5').update(fileSizePrepared).digest('hex');
            } else {
                fileMD5 = crypto.createHash('md5').update(fs.readFileSync(path.join(this.inputDir, filePath))).digest('hex');
            }

            fileList.push({
                path: filePath,
                type: 'file',
                md5: fileMD5
            });
        }

        // Save the files list
        fs.writeFileSync(
            path.join(this.inputDir, 'files.publii.json'),
            JSON.stringify(fileList, null, 4),
            {'flags': 'w'}
        );
    }

    /**
     * Check if local list is equal to the server expected copy
     * 
     * @param fileContent 
     */
    checkLocalListWithRemoteList (fileContent) {
        try {
            if (typeof fileContent === 'Buffer') {
                fileContent = fileContent.toString();
            }

            let syncRevisionPath = path.join(this.configDir, 'sync-revision.json');
            let content = JSON.parse(fileContent);
            let revisionID = false;

            if (fs.existsSync(syncRevisionPath)) {
                let syncRevisionContent = fs.readFileSync(syncRevisionPath);
                syncRevisionContent = JSON.parse(syncRevisionContent);
                revisionID = syncRevisionContent.revision;
            }

            if (content.revision) {
                let filesToCheck = fs.readFileSync(path.join(this.configDir, 'files-remote.json'));
                
                if (revisionID) {
                    let isExpectedCopy = revisionID === content.revision;
                    this.compareFilesList(isExpectedCopy);
                } else {
                    let checkSum = crypto.createHash('md5').update(filesToCheck).digest('hex');
                    let isExpectedCopy = checkSum === content.revision;
                    this.compareFilesList(isExpectedCopy);
                }
                    
                return;
            }
            
            // when files on server uses old format - download it and use as remote files list
            fs.writeFileSync(path.join(this.configDir, 'files-remote.json'), fileContent);
            this.compareFilesList(true);
        } catch (e) {
            this.compareFilesList(false);
        }
    }

    /**
     * Save files.publii.json as files-remote.json and store checksum in the file
     */
    replaceSyncInfoFiles () {
        let inputListPath = path.join(this.inputDir, 'files.publii.json');
        let remoteListPath = path.join(this.configDir, 'files-remote.json');
        let syncRevisionPath = path.join(this.configDir, 'sync-revision.json');
        let contentToSave = fs.readFileSync(inputListPath);
        let newContent = `{ "revision": "${this.syncRevision}" }`;
        fs.writeFileSync(remoteListPath, contentToSave);
        fs.writeFileSync(inputListPath, newContent);
        fs.writeFileSync(syncRevisionPath, newContent);
    }

    /**
     * Compares remote and local files lists
     *
     * @param remoteFileListExists
     */
    compareFilesList(remoteFileListExists = false) {
        let localFiles = fs.readFileSync(path.join(this.inputDir, 'files.publii.json'), 'utf8');
        let remoteFiles = false;

        if(localFiles) {
            localFiles = JSON.parse(localFiles);
        }

        if(remoteFileListExists) {
            remoteFiles = fs.readFileSync(path.join(this.configDir, 'files-remote.json'), 'utf8');

            if(remoteFiles) {
                try {
                    remoteFiles = JSON.parse(remoteFiles);

                    if (this.siteConfig.deployment.protocol === 'gitlab-pages') {
                        remoteFiles = remoteFiles.map(file => {
                            return file;
                        });
                    }
                } catch (e) {
                    remoteFiles = false;
                    console.log('Malformed files-remote.json file: ' + e);
                }
            }
        }

        if(!remoteFiles) {
            remoteFiles = [];
        }

        // Detect files to remove
        let filesToRemove = [];

        for(let remoteFile of remoteFiles) {
            let fileFounded = false;

            for(let localFile of localFiles) {
                if(localFile.path === remoteFile.path) {
                    fileFounded = true;
                    break;
                }
            }

            if(!fileFounded) {
                if (
                    (this.siteConfig.deployment.protocol === 'google-cloud' || this.siteConfig.deployment.protocol === 'gitlab-pages') &&
                    remoteFile.type === 'directory'
                ) {
                    continue;
                }

                filesToRemove.push({
                    path: remoteFile.path,
                    type: remoteFile.type
                });
            }
        }

        // Detect files to upload
        let filesToUpload = [];

        for(let localFile of localFiles) {
            let fileShouldBeUploaded = true;

            for(let remoteFile of remoteFiles) {
                if(
                    localFile.path === remoteFile.path &&
                    localFile.md5 === remoteFile.md5
                ) {
                    fileShouldBeUploaded = false;
                    break;
                }
            }

            if (fileShouldBeUploaded) {
                if (
                    (this.siteConfig.deployment.protocol === 'google-cloud' || this.siteConfig.deployment.protocol === 'gitlab-pages') &&
                    localFile.type === 'directory'
                ) {
                    continue;
                }

                filesToUpload.push({
                    path: localFile.path,
                    type: localFile.type
                });
            }
        }

        this.filesToRemove = filesToRemove;
        this.filesToUpload = filesToUpload;

        if(this.siteConfig.deployment.protocol === 's3') {
            this.operationsCounter = this.filesToRemove.filter(file => file.type === 'file').length +
                                     this.filesToUpload.filter(file => file.type === 'file').length + 1;
        } else {
            this.operationsCounter = this.filesToRemove.length + this.filesToUpload.length + 1;
        }

        this.currentOperationNumber = 0;
        console.log('Founded ' + this.operationsCounter + ' operations to do');
        this.progressPerFile = 90.0 / this.operationsCounter;
        this.sortFiles();

        process.send({
            type: 'web-contents',
            message: 'app-uploading-progress',
            value: {
                progress: 8,
                operations: false
            }
        });

        this.removeFile();
    }

    /**
     * Move files or directories to the beginning
     */
    sortFiles() {
        let self = this;

        this.filesToRemove = this.filesToRemove.sort(function(fileA, fileB) {
            if(fileA.type === 'directory') {
                return -1;
            }

            if(fileB.type === 'directory') {
                return 1;
            }

            return 0;
        });

        this.filesToUpload = this.filesToUpload.sort((fileA, fileB) => {
            if (fileA.type === 'directory') {
                return 1;
            }

            if (fileB.type === 'directory') {
                return -1;
            }

            // Images will be uploaded at the end
            if (isBinaryFileSync(path.join(this.inputDir, fileA.path))) {
                return -1;
            }

            if (isBinaryFileSync(path.join(this.inputDir, fileB.path))) {
                return 1;
            }

            return 0;
        });

        // Reorder directories to put higher order directories at the beginning
        this.filesToUpload = this.filesToUpload.sort(function(fileA, fileB) {
            if(fileA.type === 'directory' && fileB.type === 'directory') {
                if(fileA.path.length <= fileB.path.length) {
                    return 1;
                } else {
                    return -1;
                }
            }

            if(fileA.type === 'directory') {
                return 1;
            }

            if(fileB.type === 'directory') {
                return -1;
            }

            return 0;
        });

        // Reorder directories only
        this.saveConnectionFilesLog(JSON.stringify(this.filesToUpload), 'to-upload');
        this.saveConnectionFilesLog(JSON.stringify(this.filesToRemove), 'to-delete');
    }

    /**
     * Removes file
     */
    removeFile() {
        if(this.siteConfig.deployment.protocol === 's3') {
            this.client.removeFile();
            return;
        }

        if(this.siteConfig.deployment.protocol === 'gitlab-pages') {
            this.client.startSync();
            return;
        }

        let self = this;

        if(this.filesToRemove.length > 0) {
            let fileToRemove = this.filesToRemove.pop();

            if(fileToRemove.type === 'file') {
                this.client.removeFile(normalizePath(path.join(this.outputDir, fileToRemove.path)));
            } else {
                this.client.removeDirectory(normalizePath(path.join(this.outputDir, fileToRemove.path)));
            }
        } else {
            self.progressOfUploading = self.progressOfDeleting;

            process.send({
                type: 'web-contents',
                message: 'app-uploading-progress',
                value: {
                    progress: 8 + Math.floor(self.progressOfUploading),
                    operations: [self.currentOperationNumber ,self.operationsCounter]
                }
            });

            this.uploadFile();
        }
    }

    /**
     * Uploads file
     */
    uploadFile() {
        let self = this;

        if(this.filesToUpload.length > 0) {
            let fileToUpload = this.filesToUpload.pop();

            if(fileToUpload.type === 'file') {
                this.client.uploadFile(
                    normalizePath(path.join(this.inputDir, fileToUpload.path)),
                    normalizePath(path.join(this.outputDir, fileToUpload.path))
                );
            } else {
                this.client.uploadDirectory(
                    normalizePath(path.join(this.inputDir, fileToUpload.path)),
                    normalizePath(path.join(this.outputDir, fileToUpload.path))
                );
            }
        } else {
            process.send({
                type: 'web-contents',
                message: 'app-uploading-progress',
                value: {
                    progress: 98,
                    operations: [self.currentOperationNumber ,self.operationsCounter]
                }
            });

            this.client.uploadNewFileList();
        }
    }

    /**
     * Function used to get recursive list of the files and directories
     * in the specific dir
     *
     * @param dir
     * @param filelist
     *
     * @returns {Array}
     */
    readDirRecursiveSync(dir, filelist) {
        let self = this;
        let files = fs.readdirSync(dir);
        filelist = filelist || [];

        files.forEach(function(file) {
            if (file === '.git') {
                return;
            }

            if (fs.statSync(path.join(dir, file)).isDirectory()) {
                filelist.push(normalizePath(path.join(dir.replace(self.inputDir, ''), file)));
                filelist = self.readDirRecursiveSync(path.join(dir, file), filelist);
            } else {
                if(file.indexOf('.') !== 0 || file === '.htaccess' || file === '_redirects') {
                    filelist.push(normalizePath(path.join(dir.replace(self.inputDir, ''), file)));
                }
            }
        });

        return filelist;
    };

    /**
     * Save connection files log
     *
     * @param files
     * @param suffix
     */
    saveConnectionFilesLog(files, suffix = '') {
        if (suffix !== '') {
            suffix = '-' + suffix;
        }

        let logPath = path.join(this.appDir, 'connection-files-log' + suffix + '.txt');
        fs.writeFileSync(logPath, files);
    }
}

module.exports = Deployment;
