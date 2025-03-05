/**
 * LegitCHAIN TITAN - Test Environment
 * Version: 1.0.0
 * Last Updated: 2025-04-10
 * 
 * This module provides a configurable test environment for the
 * Legal Module testing framework, supporting isolated testing with
 * proper mocks and service configurations.
 */

import { 
  AIService, 
  BlockchainService, 
  DocumentService, 
  NotificationService,
  UserService,
  ConfigService
} from '../services';

import { 
  MockAIService, 
  MockBlockchainService, 
  MockDocumentService,
  MockNotificationService,
  MockUserService,
  MockConfigService
} from './mocks';

import { DatabaseClient } from '../database';
import { config } from '../config';
import * as Docker from 'dockerode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Configuration options for the test environment
 */
interface TestEnvironmentConfig {
  // Environment type
  environment?: 'local' | 'dev' | 'staging' | 'production';
  
  // Service mocking options
  mockServices?: boolean;
  useRealBlockchain?: boolean;
  
  // Mock service instances (optional, will be created if not provided)
  mockAIService?: MockAIService;
  mockBlockchainService?: MockBlockchainService;
  mockDocumentService?: MockDocumentService;
  mockNotificationService?: MockNotificationService;
  mockUserService?: MockUserService;
  mockConfigService?: MockConfigService;
  
  // Database options
  inMemoryDatabase?: boolean;
  databaseName?: string;
  
  // Docker container options
  useDockerContainers?: boolean;
  dockerContainerPrefix?: string;
  
  // Performance optimization
  optimizeForPerformance?: boolean;
  
  // Locale and jurisdiction for testing
  jurisdiction?: string;
  
  // Retry options
  retryEnabled?: boolean;
  maxRetries?: number;
  retryDelay?: number;
}

/**
 * Default configuration for the test environment
 */
const DEFAULT_CONFIG: TestEnvironmentConfig = {
  environment: 'local',
  mockServices: true,
  useRealBlockchain: false,
  inMemoryDatabase: true,
  databaseName: 'legitchain_test',
  useDockerContainers: false,
  dockerContainerPrefix: 'legitchain_test',
  optimizeForPerformance: false,
  jurisdiction: 'US',
  retryEnabled: true,
  maxRetries: 3,
  retryDelay: 500
};

/**
 * Test Environment for the Legal Module testing framework
 */
class TestEnvironment {
  private config: TestEnvironmentConfig;
  private services: any = {};
  private databaseClient: DatabaseClient | null = null;
  private dockerClient: Docker | null = null;
  private containers: any[] = [];
  private initialized: boolean = false;
  
  /**
   * Constructor
   * 
   * @param config Configuration options for the test environment
   */
  constructor(config: Partial<TestEnvironmentConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Initialize Docker client if needed
    if (this.config.useDockerContainers) {
      this.dockerClient = new Docker();
    }
  }
  
  /**
   * Initialize the test environment
   */
  async initialize() {
    if (this.initialized) {
      return;
    }
    
    console.log(`Initializing test environment for ${this.config.environment}...`);
    
    try {
      // Step 1: Initialize database
      await this.initializeDatabase();
      
      // Step 2: Start Docker containers if needed
      if (this.config.useDockerContainers) {
        await this.startContainers();
      }
      
      // Step 3: Initialize services
      await this.initializeServices();
      
      this.initialized = true;
      console.log('Test environment initialized successfully');
    } catch (error) {
      console.error('Failed to initialize test environment:', error);
      await this.cleanup();
      throw error;
    }
  }
  
  /**
   * Initialize the database for testing
   */
  private async initializeDatabase() {
    if (this.config.inMemoryDatabase) {
      console.log('Using in-memory database for testing');
      
      // Initialize in-memory database
      this.databaseClient = new DatabaseClient({
        inMemory: true,
        databaseName: this.config.databaseName
      });
      
      await this.databaseClient.connect();
      await this.databaseClient.reset();
    } else {
      console.log(`Connecting to ${this.config.environment} database`);
      
      // Connect to real database based on environment
      const dbConfig = config.database[this.config.environment];
      this.databaseClient = new DatabaseClient(dbConfig);
      
      await this.databaseClient.connect();
      
      // Create test schema if needed
      if (this.config.environment === 'local' || this.config.environment === 'dev') {
        await this.databaseClient.reset();
      }
    }
  }
  
  /**
   * Start Docker containers for testing
   */
  private async startContainers() {
    if (!this.dockerClient) {
      throw new Error('Docker client not initialized');
    }
    
    console.log('Starting Docker containers for testing...');
    
    // Define container configurations
    const containerConfigs = [
      {
        name: `${this.config.dockerContainerPrefix}_redis`,
        Image: 'redis:latest',
        Ports: [{ HostPort: '6379', ContainerPort: '6379' }]
      },
      {
        name: `${this.config.dockerContainerPrefix}_mongodb`,
        Image: 'mongo:latest',
        Ports: [{ HostPort: '27017', ContainerPort: '27017' }],
        Env: ['MONGO_INITDB_DATABASE=legitchain_test']
      }
    ];
    
    // Add blockchain node container if using real blockchain
    if (this.config.useRealBlockchain) {
      containerConfigs.push({
        name: `${this.config.dockerContainerPrefix}_blockchain`,
        Image: 'ethereum/client-go:latest',
        Ports: [{ HostPort: '8545', ContainerPort: '8545' }],
        Cmd: ['--dev', '--http', '--http.addr=0.0.0.0', '--http.api=eth,net,web3,personal']
      });
    }
    
    // Start each container
    for (const containerConfig of containerConfigs) {
      // Check if container already exists
      const existingContainers = await this.dockerClient.listContainers({
        all: true,
        filters: { name: [containerConfig.name] }
      });
      
      let container;
      
      if (existingContainers.length > 0) {
        // Container exists, get it
        container = this.dockerClient.getContainer(existingContainers[0].Id);
        
        // Start container if it's not running
        if (existingContainers[0].State !== 'running') {
          console.log(`Starting existing container: ${containerConfig.name}`);
          await container.start();
        } else {
          console.log(`Container already running: ${containerConfig.name}`);
        }
      } else {
        // Create and start new container
        console.log(`Creating container: ${containerConfig.name}`);
        container = await this.dockerClient.createContainer({
          name: containerConfig.name,
          Image: containerConfig.Image,
          ExposedPorts: containerConfig.Ports.reduce((ports, port) => {
            ports[`${port.ContainerPort}/tcp`] = {};
            return ports;
          }, {}),
          HostConfig: {
            PortBindings: containerConfig.Ports.reduce((bindings, port) => {
              bindings[`${port.ContainerPort}/tcp`] = [{ HostPort: port.HostPort }];
              return bindings;
            }, {}),
            RestartPolicy: { Name: 'always' }
          },
          Env: containerConfig.Env || [],
          Cmd: containerConfig.Cmd || []
        });
        
        console.log(`Starting container: ${containerConfig.name}`);
        await container.start();
      }
      
      this.containers.push(container);
      
      // Wait for container to be ready
      console.log(`Waiting for ${containerConfig.name} to be ready...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log('All containers started successfully');
  }
  
  /**
   * Initialize services for testing
   */
  private async initializeServices() {
    console.log('Initializing services...');
    
    if (this.config.mockServices) {
      // Initialize mock services
      this.services = {
        aiService: this.config.mockAIService || new MockAIService(),
        blockchainService: this.config.useRealBlockchain
          ? new BlockchainService({ client: this.getBlockchainClient() })
          : (this.config.mockBlockchainService || new MockBlockchainService()),
        documentService: this.config.mockDocumentService || new MockDocumentService(),
        notificationService: this.config.mockNotificationService || new MockNotificationService(),
        userService: this.config.mockUserService || new MockUserService(),
        configService: this.config.mockConfigService || new MockConfigService()
      };
      
      // Store original method references for potential error injection
      for (const [serviceName, service] of Object.entries(this.services)) {
        if (typeof service === 'object' && service !== null) {
          for (const methodName of Object.getOwnPropertyNames(Object.getPrototypeOf(service))) {
            if (typeof service[methodName] === 'function' && methodName !== 'constructor') {
              service[`_original${methodName.charAt(0).toUpperCase()}${methodName.slice(1)}`] = service[methodName];
            }
          }
        }
      }
      
      console.log('Mock services initialized');
    } else {
      // Initialize real services
      this.services = {
        aiService: new AIService({
          endpoint: config.services.ai[this.config.environment].endpoint,
          apiKey: config.services.ai[this.config.environment].apiKey
        }),
        blockchainService: new BlockchainService({
          client: this.getBlockchainClient()
        }),
        documentService: new DocumentService({
          databaseClient: this.databaseClient
        }),
        notificationService: new NotificationService({
          endpoint: config.services.notification[this.config.environment].endpoint,
          apiKey: config.services.notification[this.config.environment].apiKey
        }),
        userService: new UserService({
          databaseClient: this.databaseClient
        }),
        configService: new ConfigService({
          environment: this.config.environment
        })
      };
      
      console.log('Real services initialized');
    }
    
    // Apply performance optimizations if enabled
    if (this.config.optimizeForPerformance) {
      this.applyPerformanceOptimizations();
    }
    
    // Apply retry logic if enabled
    if (this.config.retryEnabled) {
      this.applyRetryLogic();
    }
  }
  
  /**
   * Get blockchain client based on configuration
   */
  private getBlockchainClient() {
    if (this.config.useRealBlockchain) {
      // Use environment-specific blockchain configuration
      const blockchainConfig = config.blockchain[this.config.environment];
      
      // If using Docker, override with local endpoint
      if (this.config.useDockerContainers) {
        blockchainConfig.endpoint = 'http://localhost:8545';
      }
      
      return {
        endpoint: blockchainConfig.endpoint,
        privateKey: blockchainConfig.privateKey,
        chainId: blockchainConfig.chainId
      };
    }
    
    // Return null if not using real blockchain
    return null;
  }
  
  /**
   * Apply performance optimizations to services
   */
  private applyPerformanceOptimizations() {
    console.log('Applying performance optimizations...');
    
    // Optimize AI service by caching responses
    if (this.services.aiService instanceof MockAIService) {
      this.services.aiService.enableCaching = true;
    }
    
    // Optimize blockchain service by batching transactions
    if (this.services.blockchainService instanceof MockBlockchainService) {
      this.services.blockchainService.batchTransactions = true;
    }
    
    // Optimize document service by disabling validation
    if (this.services.documentService instanceof MockDocumentService) {
      this.services.documentService.skipValidation = true;
    }
  }
  
  /**
   * Apply retry logic to service methods
   */
  private applyRetryLogic() {
    console.log('Applying retry logic to services...');
    
    const retryLogic = async (fn, args, maxRetries, delay) => {
      let lastError;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          return await fn(...args);
        } catch (error) {
          lastError = error;
          
          // Only retry if error is retryable
          if (error.permanent === true) {
            throw error;
          }
          
          console.log(`Attempt ${attempt} failed, retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          
          // Increase delay for next attempt
          delay *= 1.5;
        }
      }
      
      throw lastError;
    };
    
    // Apply retry logic to service methods
    for (const [serviceName, service] of Object.entries(this.services)) {
      if (typeof service === 'object' && service !== null) {
        for (const methodName of Object.getOwnPropertyNames(Object.getPrototypeOf(service))) {
          if (typeof service[methodName] === 'function' && methodName !== 'constructor') {
            const originalMethod = service[methodName];
            
            service[methodName] = async (...args) => {
              return retryLogic(
                originalMethod.bind(service),
                args,
                this.config.maxRetries,
                this.config.retryDelay
              );
            };
          }
        }
      }
    }
  }
  
  /**
   * Get all services
   * 
   * @returns Object containing all services
   */
  getServices() {
    if (!this.initialized) {
      throw new Error('Test environment not initialized. Call initialize() first.');
    }
    
    return this.services;
  }
  
  /**
   * Get a specific service
   * 
   * @param serviceName Name of the service to get
   * @returns The requested service
   */
  getService(serviceName: string) {
    if (!this.initialized) {
      throw new Error('Test environment not initialized. Call initialize() first.');
    }
    
    if (!this.services[serviceName]) {
      throw new Error(`Service ${serviceName} not found`);
    }
    
    return this.services[serviceName];
  }
  
  /**
   * Update or replace a service
   * 
   * @param serviceName Name of the service to update
   * @param service New service instance
   */
  updateService(serviceName: string, service: any) {
    if (!this.initialized) {
      throw new Error('Test environment not initialized. Call initialize() first.');
    }
    
    if (!this.services[serviceName]) {
      throw new Error(`Service ${serviceName} not found`);
    }
    
    this.services[serviceName] = service;
  }
  
  /**
   * Reset the test environment
   */
  async reset() {
    console.log('Resetting test environment...');
    
    // Reset database if available
    if (this.databaseClient) {
      await this.databaseClient.reset();
    }
    
    // Reset services
    await this.initializeServices();
    
    console.log('Test environment reset complete');
  }
  
  /**
   * Clean up the test environment
   */
  async cleanup() {
    console.log('Cleaning up test environment...');
    
    // Close database connection if open
    if (this.databaseClient) {
      await this.databaseClient.disconnect();
      this.databaseClient = null;
    }
    
    // Stop Docker containers if needed
    if (this.config.useDockerContainers && this.containers.length > 0) {
      console.log('Stopping Docker containers...');
      
      for (const container of this.containers) {
        try {
          await container.stop();
          console.log(`Container ${container.id} stopped`);
        } catch (error) {
          console.error(`Failed to stop container ${container.id}:`, error);
        }
      }
      
      this.containers = [];
    }
    
    this.initialized = false;
    console.log('Test environment cleanup complete');
  }
  
  /**
   * Create a test database fixture
   * 
   * @param fixtureName Name of the fixture to create
   */
  async createDatabaseFixture(fixtureName: string) {
    if (!this.databaseClient) {
      throw new Error('Database client not initialized');
    }
    
    console.log(`Creating database fixture: ${fixtureName}`);
    
    // Load fixture data from file
    const fixtureFile = path.join(__dirname, 'fixtures', `${fixtureName}.json`);
    
    if (!fs.existsSync(fixtureFile)) {
      throw new Error(`Fixture file not found: ${fixtureFile}`);
    }
    
    const fixtureData = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
    
    // Apply fixture data to database
    for (const [collection, documents] of Object.entries(fixtureData)) {
      await this.databaseClient.collection(collection).insertMany(documents as any[]);
    }
    
    console.log(`Database fixture ${fixtureName} created successfully`);
  }
  
  /**
   * Static helper method to create and initialize a test environment
   * 
   * @param config Configuration options for the test environment
   * @returns Initialized test environment
   */
  static async create(config: Partial<TestEnvironmentConfig> = {}) {
    const env = new TestEnvironment(config);
    await env.initialize();
    return env;
  }
}

// Export the test environment
export { TestEnvironment, TestEnvironmentConfig };