# Minimal image for Glama build/introspection: runs the published CLI over stdio.
# The server starts and lists its tools without any database configured
# (connections are opened lazily), so MCP introspection succeeds out of the box.
FROM node:22-slim
RUN npm install -g @rheopyrin/db-access-mcp@latest
ENTRYPOINT ["db-access-mcp"]
