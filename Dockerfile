FROM mcr.microsoft.com/playwright:v1.60.0-jammy

# App directory configuration
WORKDIR /app

# Copy dependency maps
COPY package*.json ./

# Install dynamic packages
RUN npm install

# Copy application layers
COPY . .

# Expose port and boot up sequence
EXPOSE 3000
CMD ["npm", "start"]
