import { MetadataCache, TFile, Vault, Notice, getLinkpath} from "obsidian";
import DigitalGardenSettings from "DigitalGardenSettings";
import { Base64 } from "js-base64";
import { Octokit } from "@octokit/core";
import { arrayBufferToBase64 } from "utils";
import { vallidatePublishFrontmatter } from "Validator";

class Publisher {
    vault: Vault;
    metadataCache: MetadataCache;
    settings: DigitalGardenSettings;

    constructor(vault: Vault, metadataCache: MetadataCache, settings: DigitalGardenSettings) {
        this.vault = vault;
        this.metadataCache = metadataCache;
        this.settings = settings;
    }

    async getFilesMarkedForPublishing(): Promise<TFile[]> {
        const files = this.vault.getMarkdownFiles();
        const filesToPublish = [];
        for (const file of files) {
            try {
                const frontMatter = this.metadataCache.getCache(file.path).frontmatter
                if (frontMatter && frontMatter["dg-publish"] === true) {
                    filesToPublish.push(file);
                }
            } catch {
                //ignore
            }
        }

        return filesToPublish;
    }

    async publish(file: TFile) {
        if(!vallidatePublishFrontmatter(this.metadataCache.getCache(file.path).frontmatter)){
            return;
        }
        const text = await this.generateMarkdown(file);
        await this.uploadText(file.name, text);
    }

    async generateMarkdown(file: TFile): Promise<string> {
        let text = await this.vault.cachedRead(file);
        text = await this.convertFrontMatter(text, file.path);
        text = await this.createTranscludedText(text, file.path);
        text = await this.createBase64Images(text, file.path);
        return text;

    }


    async uploadText(title: string, content: string) {
        if (!this.settings.githubRepo) {
            new Notice("Config error: You need to define a GitHub repo in the plugin settings");
            throw {};
        }
        if (!this.settings.githubUserName) {
            new Notice("Config error: You need to define a GitHub Username in the plugin settings");
            throw {};
        }
        if (!this.settings.githubToken) {
            new Notice("Config error: You need to define a GitHub Token in the plugin settings");
            throw {};
        }


        const octokit = new Octokit({ auth: this.settings.githubToken });


        const base64Content = Base64.encode(content);
        const path = `src/site/notes/${title}`

        const payload = {
            owner: this.settings.githubUserName,
            repo: this.settings.githubRepo,
            path,
            message: `Add note ${title}`,
            content: base64Content,
            sha: ''
        };

        try {
            const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                owner: this.settings.githubUserName,
                repo: this.settings.githubRepo,
                path
            });
            if (response.status === 200 && response.data.type === "file") {
                payload.sha = response.data.sha;
            }
        } catch (e) {
            console.log(e)
        }

        payload.message = `Update note ${title}`;

        await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', payload);

    }

    async convertFrontMatter(text: string, path: string): Promise<string> {
        const frontMatter = this.metadataCache.getCache(path).frontmatter;
        if (frontMatter && frontMatter["dg-permalink"]) {
            frontMatter["permalink"] = frontMatter["dg-permalink"];
            if (!frontMatter["permalink"].endsWith("/")) {
                frontMatter["permalink"] += "/";
            }
        }


        if (frontMatter && frontMatter["dg-home"]) {
            const tags = frontMatter["tags"];
            if (tags) {
                if (typeof (tags) === "string") {
                    frontMatter["tags"] = [tags, "gardenEntry"];
                } else {
                    frontMatter["tags"] = [...tags, "gardenEntry"];
                }
            } else {
                frontMatter["tags"] = "gardenEntry";
            }

        }
        //replace frontmatter at start of file

        const replaced = text.replace(/^---\n([\s\S]*?)\n---/g, (match, p1) => {
            const copy = { ...frontMatter };
            delete copy["position"];
            delete copy["end"];
            const frontMatterString = JSON.stringify(copy);
            return `---\n${frontMatterString}\n---`;
        });
        return replaced;
    }

    async createTranscludedText(text: string, filePath: string): Promise<string> {
        let transcludedText = text;
        const transcludedRegex = /!\[\[(.*?)\]\]/g;
        const transclusionMatches = text.match(transcludedRegex);
        if (transclusionMatches) {
            for (let i = 0; i < transclusionMatches.length; i++) {
                try {
                    const transclusionMatch = transclusionMatches[i];
                    const tranclusionFileName = transclusionMatch.substring(transclusionMatch.indexOf('[') + 2, transclusionMatch.indexOf(']'));
                    const tranclusionFilePath = getLinkpath(tranclusionFileName);
                    const linkedFile = this.metadataCache.getFirstLinkpathDest(tranclusionFilePath, filePath);
                    if (["md", "txt"].indexOf(linkedFile.extension) == -1) {
                        continue;
                    }
                    let fileText = await this.vault.cachedRead(linkedFile);
                    fileText = "\n```transclusion\n# " + tranclusionFileName + "\n\n" + fileText + '\n```\n'
                    //This should be recursive up to a certain depth
                    transcludedText = transcludedText.replace(transclusionMatch, fileText);
                } catch {
                    continue;
                }
            }
        }

        return transcludedText;

    }

    async createBase64Images(text: string, filePath: string): Promise<string> {
        let imageText = text;
        const imageRegex = /!\[\[(.*?)(\.(png|jpg|jpeg|gif))\]\]/g;
        const imageMatches = text.match(imageRegex);
        if (imageMatches) {
            for (let i = 0; i < imageMatches.length; i++) {
                try {
                    const imageMatch = imageMatches[i];
                    const imageName = imageMatch.substring(imageMatch.indexOf('[') + 2, imageMatch.indexOf(']'));
                    const imagePath = getLinkpath(imageName);
                    const linkedFile = this.metadataCache.getFirstLinkpathDest(imagePath, filePath);
                    const image = await this.vault.readBinary(linkedFile);
                    const imageBase64 = arrayBufferToBase64(image)
                    const imageMarkdown = `![${imageName}](data:image/${linkedFile.extension};base64,${imageBase64})`;
                    imageText = imageText.replace(imageMatch, imageMarkdown);
                } catch {
                    continue;
                }
            }
        }

        return imageText;
    }
}

export default Publisher;