# claude-skills

Skills for [Claude Code](https://claude.com/claude-code), packaged as a plugin marketplace.

| Plugin | What it does |
|---|---|
| [seo-audit](plugins/seo-audit) | Developer-ready SEO audit of any web page, delivered as a designed HTML report and a one-page PDF |

## Install

In Claude Code:

```
/plugin marketplace add ishakhawat/claude-skills
/plugin install seo-audit@claude-skills
```

Then ask for an audit, or run the skill directly:

```
/seo-audit https://example.com/pricing/
```

To update later: `/plugin marketplace update claude-skills`.

## Adding a skill

Each plugin lives in `plugins/<name>/` with a `.claude-plugin/plugin.json` and its skills in `plugins/<name>/skills/<skill>/SKILL.md`. Add an entry for it to `.claude-plugin/marketplace.json`.

## License

MIT
