#!/usr/bin/env ruby

require "json"
require "yaml"

ROOT = File.expand_path("..", __dir__)

def relative(path)
  path.delete_prefix("#{ROOT}/")
end

def read_markdown(path)
  text = File.read(path)
  parts = text.split(/^---\s*$\n/, 3)
  raise "Missing YAML frontmatter: #{relative(path)}" unless parts.length == 3

  frontmatter = YAML.safe_load(parts[1], permitted_classes: [], aliases: false) || {}
  [frontmatter, parts[2]]
rescue Psych::SyntaxError => error
  raise "Invalid YAML in #{relative(path)}: #{error.message}"
end

def assert(condition, message)
  raise message unless condition
end

config = JSON.parse(File.read(File.join(ROOT, "opencode.json")))

skills = {}
Dir[File.join(ROOT, ".opencode/skills/*/SKILL.md")].sort.each do |path|
  data, body = read_markdown(path)
  directory = File.basename(File.dirname(path))
  name = data["name"]
  description = data["description"].to_s

  assert(data.keys.sort == %w[description name], "Unexpected skill frontmatter keys: #{relative(path)}")
  assert(name == directory, "Skill name does not match its directory: #{relative(path)}")
  assert(name.match?(/\A[a-z0-9]+(?:-[a-z0-9]+)*\z/), "Invalid skill name: #{name}")
  assert(name.length <= 64, "Skill name exceeds 64 characters: #{name}")
  assert(description.length.between?(1, 1024), "Invalid skill description length: #{name}")
  assert(body.lines.length < 500, "Skill body is 500 lines or longer: #{name}")
  assert(!skills.key?(name), "Duplicate skill name: #{name}")
  skills[name] = path
end

agents = {}
agent_bodies = {}
Dir[File.join(ROOT, ".opencode/agents/*.md")].sort.each do |path|
  data, body = read_markdown(path)
  id = File.basename(path, ".md")
  allowed_keys = %w[color description mode permission steps temperature]

  assert((data.keys - allowed_keys).empty?, "Unexpected agent frontmatter keys: #{relative(path)}")
  assert(!data["description"].to_s.empty?, "Missing agent description: #{id}")
  assert(%w[primary subagent all].include?(data["mode"]), "Invalid agent mode: #{id}")
  assert(data["steps"].is_a?(Integer) && data["steps"].positive?, "Invalid step budget: #{id}")

  skill_rules = data.dig("permission", "skill") || {}
  assert(skill_rules["*"] == "deny", "Agent skill allowlist must begin from deny-all: #{id}")
  skill_rules.each do |name, action|
    next if name == "*"

    assert(skills.key?(name), "Unknown skill '#{name}' in agent '#{id}'")
    assert(action == "allow", "Skill '#{name}' is not allowed in agent '#{id}'")
    assert(body.include?("`#{name}`"), "Agent '#{id}' does not instruct use of allowed skill '#{name}'")
  end

  assert(!agents.key?(id), "Duplicate agent ID: #{id}")
  agents[id] = data
  agent_bodies[id] = body
end

commands = {}
Dir[File.join(ROOT, ".opencode/commands/*.md")].sort.each do |path|
  data, body = read_markdown(path)
  id = File.basename(path, ".md")

  assert((data.keys - %w[agent description subtask]).empty?, "Unexpected command frontmatter keys: #{relative(path)}")
  assert(agents.key?(data["agent"]), "Unknown agent '#{data["agent"]}' in command '#{id}'")
  assert(!data["description"].to_s.empty?, "Missing command description: #{id}")
  assert(body.include?("$ARGUMENTS"), "Command does not accept arguments: #{id}")
  commands[id] = data
end

default_agent = config.fetch("default_agent")
assert(agents.dig(default_agent, "mode") == "primary", "Default agent is missing or is not primary")

subagents = agents.select { |_, data| data["mode"] == "subagent" }.keys.sort
task_rules = agents.fetch(default_agent).dig("permission", "task") || {}
orchestrated = task_rules.select { |name, action| name != "*" && action == "allow" }.keys.sort
assert(task_rules["*"] == "deny", "Orchestrator task allowlist must begin from deny-all")
assert(subagents == orchestrated, "Orchestrator task allowlist does not exactly match the specialist set")

assert(agents.length == 18, "Expected 18 agents, found #{agents.length}")
assert(agents.count { |_, data| data["mode"] == "primary" } == 1, "Expected exactly one primary agent")
assert(skills.length == 19, "Expected 19 skills, found #{skills.length}")
assert(commands.length == 7, "Expected 7 commands, found #{commands.length}")

instruction_patterns = config.fetch("instructions")
instruction_files = instruction_patterns.flat_map { |pattern| Dir[File.join(ROOT, pattern)] }.uniq
assert(!instruction_files.empty?, "Configured instruction patterns match no files")

Dir[File.join(ROOT, ".opencode/skills/*/agents/openai.yaml")].sort.each do |path|
  data = YAML.safe_load(File.read(path), permitted_classes: [], aliases: false)
  interface = data.fetch("interface")
  skill = File.basename(File.dirname(File.dirname(path)))
  short_description = interface.fetch("short_description")
  default_prompt = interface.fetch("default_prompt")

  assert(short_description.length.between?(25, 64), "Invalid short_description: #{relative(path)}")
  assert(default_prompt.include?("$#{skill}"), "Default prompt does not mention $#{skill}: #{relative(path)}")
end

scanned_files = [
  File.join(ROOT, "AGENTS.md"),
  File.join(ROOT, "README.md"),
  File.join(ROOT, "opencode.json"),
  *Dir[File.join(ROOT, ".opencode/**/*")]
].select { |path| File.file?(path) }

scanned_files.each do |path|
  assert(!File.read(path).match?(/\b(?:TODO|PLACEHOLDER)\b/), "Unresolved placeholder: #{relative(path)}")
end

puts JSON.pretty_generate(
  status: "valid",
  default_agent: default_agent,
  primary_agents: agents.count { |_, data| data["mode"] == "primary" },
  subagents: subagents.length,
  skills: skills.length,
  commands: commands.length,
  instruction_files: instruction_files.map { |path| relative(path) }
)
