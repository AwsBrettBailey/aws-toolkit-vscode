/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import apiConfig = require('../../../types/REMOVED.json')
import globals from '../extensionGlobals'

import * as nls from 'vscode-nls'
const localize = nls.loadMessageBundle()

import * as vscode from 'vscode'
import * as AWS from 'aws-sdk'
import * as caws from '../../../types/clientcodeaws'
import * as logger from '../logger/logger'
import { ServiceConfigurationOptions } from 'aws-sdk/lib/service'
import { Timeout, waitTimeout, waitUntil } from '../utilities/timeoutUtils'
import { showMessageWithCancel } from '../utilities/messages'
import { assertHasProps, ClassToInterfaceType, RequiredProps } from '../utilities/tsUtils'
import { AsyncCollection, toCollection } from '../utilities/asyncCollection'
import { pageableToCollection } from '../utilities/collectionUtils'
import { DevSettings } from '../settings'
import { Credentials } from 'aws-sdk'

// XXX: remove signing from the CAWS model until Bearer token auth is added to the SDKs
delete (apiConfig.metadata as Partial<typeof apiConfig['metadata']>)['signatureVersion']

// REMOVE ME SOON: only used for development
interface CawsConfig {
    readonly region: string
    readonly endpoint: string
    readonly hostname: string
    readonly gitHostname: string
}

export function getCawsConfig(): CawsConfig {
    const stage = DevSettings.instance.get('cawsStage', 'gamma')

    if (stage === 'gamma') {
        return {
            region: 'us-west-2',
            endpoint: 'https://public.api-gamma.REMOVED.codes',
            hostname: 'integ.stage.REMOVED.codes',
            gitHostname: 'git.gamma.source.caws.REMOVED',
        }
    } else {
        return {
            region: 'us-east-1',
            endpoint: 'https://public.api.REMOVED.codes',
            hostname: 'REMOVED.codes',
            gitHostname: 'git.service.REMOVED.codes',
        }
    }
}

export interface DevelopmentWorkspace extends caws.DevelopmentWorkspaceSummary {
    readonly type: 'env'
    readonly id: string
    readonly org: Pick<CawsOrg, 'name'>
    readonly project: Pick<CawsProject, 'name'>
}

/** CAWS developer environment session. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface CawsDevEnvSession extends caws.StartSessionDevelopmentWorkspaceResponse {}

export interface CawsOrg extends caws.OrganizationSummary {
    readonly type: 'org'
    readonly name: string
    readonly id: string // TODO: why doesn't OrganizationSummary have this already?
}

export interface CawsProject extends caws.ProjectSummary {
    readonly type: 'project'
    readonly name: string
    readonly id: string // TODO: why doesn't ProjectSummary have this already?
    readonly org: Pick<CawsOrg, 'name'>
}

export interface CawsRepo extends caws.SourceRepositorySummary {
    readonly type: 'repo'
    readonly name: string
    readonly org: Pick<CawsOrg, 'name'>
    readonly project: Pick<CawsProject, 'name'>
}

export interface CawsBranch extends caws.SourceBranchSummary {
    readonly type: 'branch'
    readonly name: string
    readonly repo: CawsRepo
}

export type CawsResource = CawsOrg | CawsProject | CawsRepo | CawsBranch | DevelopmentWorkspace

function intoDevelopmentWorkspace(
    organizationName: string,
    projectName: string,
    summary: caws.DevelopmentWorkspaceSummary
): DevelopmentWorkspace {
    return {
        type: 'env',
        org: { name: organizationName },
        project: { name: projectName },
        ...summary,
    }
}

async function createCawsClient(
    bearerToken: string | undefined,
    regionCode = getCawsConfig().region,
    endpoint = getCawsConfig().endpoint
): Promise<caws> {
    const c = (await globals.sdkClientBuilder.createAwsService(AWS.Service, {
        apiConfig: apiConfig,
        region: regionCode,
        correctClockSkew: true,
        endpoint: endpoint,
        // XXX: Toolkit logic on mainline does not have the concept of being 'logged-in'
        // in more than one place. So we add fake credentials here until the two concepts
        // can be combined into one.
        credentials: new Credentials({ accessKeyId: 'xxx', secretAccessKey: 'xxx' }),
    } as ServiceConfigurationOptions)) as caws
    c.setupRequestListeners = r => {
        if (bearerToken) {
            // TODO: remove this when using an SDK that supports bearer auth
            r.httpRequest.headers['Authorization'] = `Bearer ${bearerToken}`
        }
    }

    return c
}

export type UserDetails = RequiredProps<
    caws.GetUserDetailsResponse,
    'userId' | 'userName' | 'displayName' | 'primaryEmail'
> & {
    readonly version: '1'
}

// CAWS client has two variants: 'logged-in' and 'not logged-in'
// The 'not logged-in' variant is a subtype and has restricted functionality
// These characteristics appear in the Smithy model, but the SDK codegen is unable to model this

export interface DisconnectedCawsClient extends Pick<CawsClientInternal, 'verifySession' | 'setCredentials'> {
    readonly connected: false
}

export interface ConnectedCawsClient extends ClassToInterfaceType<CawsClientInternal> {
    readonly connected: true
    readonly regionCode: string
    readonly identity: { readonly id: string; readonly name: string }
    readonly token: string
}

export type CawsClient = ConnectedCawsClient | DisconnectedCawsClient
export type CawsClientFactory = () => Promise<CawsClient>

/**
 * Factory to create a new `CawsClient`. Call `onCredentialsChanged()` before making requests.
 */
export async function createClient(
    authCookie?: string,
    regionCode = getCawsConfig().region,
    endpoint = getCawsConfig().endpoint
): Promise<CawsClient> {
    const sdkClient = await createCawsClient(authCookie, regionCode, endpoint)
    const c = new CawsClientInternal(regionCode, endpoint, sdkClient, authCookie)
    return c
}

class CawsClientInternal {
    private userId: string | undefined
    private userDetails?: UserDetails
    private readonly log: logger.Logger

    public constructor(
        public readonly regionCode: string,
        private readonly endpoint: string,
        private sdkClient: caws,
        private bearerToken?: string
    ) {
        this.log = logger.getLogger()
    }

    public get connected(): boolean {
        return !!(this.bearerToken && this.userDetails)
    }

    public get identity(): ConnectedCawsClient['identity'] {
        if (!this.userDetails) {
            throw new Error('CAWS client is not connected')
        }

        return { id: this.userDetails.userId, name: this.userDetails.userName }
    }

    public get token(): ConnectedCawsClient['token'] {
        if (!this.connected) {
            throw new Error('CAWS client is not connected')
        }

        return this.bearerToken as string
    }

    /**
     * Rebuilds/reconnects CAWS clients with new credentials
     *
     * @param bearerToken   User secret
     * @param userId       CAWS account id
     * @returns
     */
    public async setCredentials(bearerToken: string, id?: string | UserDetails) {
        this.bearerToken = bearerToken
        this.sdkClient = await createCawsClient(bearerToken, this.regionCode, this.endpoint)

        if (typeof id === 'string') {
            this.userId = id
        } else {
            this.userDetails = id
        }
    }

    private async call<T>(req: AWS.Request<T, AWS.AWSError>, silent: true, defaultVal: T): Promise<T>
    private async call<T>(req: AWS.Request<T, AWS.AWSError>, silent: false): Promise<T>
    private async call<T>(req: AWS.Request<T, AWS.AWSError>, silent: boolean, defaultVal?: T): Promise<T> {
        const log = this.log
        return new Promise<T>((resolve, reject) => {
            req.send(function (e, data) {
                const r = req as any
                if (e) {
                    const allHeaders = r?.response?.httpResponse?.headers
                    const logHeaders = {}
                    // Selected headers which are useful for logging.
                    const logHeaderNames = [
                        // 'access-control-expose-headers',
                        // 'cache-control',
                        // 'strict-transport-security',
                        'x-amz-apigw-id',
                        'x-amz-cf-id',
                        'x-amz-cf-pop',
                        'x-amzn-remapped-content-length',
                        'x-amzn-remapped-x-amzn-requestid',
                        'x-amzn-requestid',
                        'x-amzn-served-from',
                        'x-amzn-trace-id',
                        'x-cache',
                        'x-request-id', // <- Request id for caws/fusi!
                    ]
                    if (allHeaders && Object.keys(allHeaders).length > 0) {
                        for (const k of logHeaderNames) {
                            ;(logHeaders as any)[k] = (k in allHeaders ? allHeaders : logHeaderNames)[k]
                        }
                    }

                    // Stack is noisy and useless in production.
                    const errNoStack = { ...e }
                    delete errNoStack.stack
                    // Remove confusing "requestId" field (= "x-amzn-requestid" header)
                    // because for caws/fusi, "x-request-id" is more relevant.
                    // All of the various request-ids can be found in the logged headers.
                    delete errNoStack.requestId

                    if (r.operation || r.params) {
                        log.error(
                            'API request failed: %s\nparams: %O\nerror: %O\nheaders: %O',
                            r.operation,
                            r.params,
                            errNoStack,
                            logHeaders
                        )
                    } else {
                        log.error('API request failed:%O\nheaders: %O', req, logHeaders)
                    }
                    if (silent) {
                        if (defaultVal === undefined) {
                            throw Error()
                        }
                        resolve(defaultVal)
                    } else {
                        reject(e)
                    }
                    return
                }
                log.verbose('API request (%s):\nparams: %O\nresponse: %O', r.operation ?? '?', r.params ?? '?', data)
                resolve(data)
            })
        })
    }

    /**
     * Creates a PAT.
     *
     * @param args.name Name of the token
     * @param args.expires PAT expires on this date, or undefined.
     * @returns PAT secret
     */
    public async createAccessToken(args: caws.CreateAccessTokenRequest): Promise<caws.CreateAccessTokenResponse> {
        return this.sdkClient.createAccessToken(args).promise()
    }

    /**
     * Gets identity properties of the current authenticated principal, and
     * stores the id for use in later calls.
     */
    public async verifySession(): Promise<UserDetails> {
        const resp = await this.call(this.sdkClient.verifySession(), false)
        assertHasProps(resp, 'identity')

        if (this.userId && this.userId !== resp.identity) {
            throw new Error('CAWS identity does not match the one provided by the client')
        }

        this.userId = resp.identity
        this.userDetails ??= await this.getUserDetails({ id: this.userId })

        return { ...this.userDetails }
    }

    private async getUserDetails(args: caws.GetUserDetailsRequest) {
        const resp = await this.call(this.sdkClient.getUserDetails(args), false)
        assertHasProps(resp, 'userId', 'userName', 'displayName', 'primaryEmail')

        if (resp.version !== '1') {
            throw new Error(`CAWS 'getUserDetails' API returned an unsupported version: ${resp.version}`)
        }

        return { ...resp, version: resp.version } as const
    }

    public async getOrg(request: caws.GetOrganizationInput): Promise<CawsOrg | undefined> {
        const resp = await this.call(this.sdkClient.getOrganization(request), false)
        assertHasProps(resp, 'id', 'name')

        return { ...resp, type: 'org' }
    }

    public async getProject(request: caws.GetProjectInput): Promise<CawsProject | undefined> {
        const resp = await this.call(this.sdkClient.getProject(request), false)
        assertHasProps(resp, 'id', 'name')

        return { ...resp, type: 'project', org: { name: request.organizationName } }
    }

    /**
     * Gets a list of all orgs for the current CAWS user.
     */
    public listOrgs(request: caws.ListOrganizationsInput = {}): AsyncCollection<CawsOrg[]> {
        function asCawsOrg(org: caws.OrganizationSummary & { id?: string }): CawsOrg {
            return { id: '', type: 'org', name: org.name ?? 'unknown', ...org }
        }

        const requester = async (request: caws.ListOrganizationsInput) =>
            this.call(this.sdkClient.listOrganizations(request), true, { items: [] })
        const collection = pageableToCollection(requester, request, 'nextToken', 'items')
        return collection.map(summaries => summaries?.map(asCawsOrg) ?? [])
    }

    /**
     * Gets a list of all projects for the given CAWS user.
     */
    public listProjects(request: caws.ListProjectsInput): AsyncCollection<CawsProject[]> {
        const requester = async (request: caws.ListProjectsInput) =>
            this.call(this.sdkClient.listProjects(request), true, { items: [] })
        const collection = pageableToCollection(requester, request, 'nextToken', 'items')

        return collection.map(
            summaries =>
                summaries?.map(s => ({
                    type: 'project',
                    id: '',
                    org: { name: request.organizationName },
                    name: s.name ?? 'unknown',
                    ...s,
                })) ?? []
        )
    }

    /**
     * CAWS
     * Gets a flat list of all workspaces for the given CAWS project.
     */
    public listDevEnvs(proj: CawsProject): AsyncCollection<DevelopmentWorkspace[]> {
        const initRequest = { organizationName: proj.org.name, projectName: proj.name }
        const requester = async (request: caws.ListDevelopmentWorkspaceRequest) =>
            this.call(this.sdkClient.listDevelopmentWorkspace(request), true, { items: [] })
        const collection = pageableToCollection(requester, initRequest, 'nextToken', 'items')

        return collection.map(envs => envs.map(s => intoDevelopmentWorkspace(proj.org.name, proj.name, s)))
    }

    /**
     * Gets a flat list of all repos for the given CAWS user.
     */
    public listRepos(request: caws.ListSourceRepositoriesInput): AsyncCollection<CawsRepo[]> {
        const requester = async (request: caws.ListSourceRepositoriesInput) =>
            this.call(this.sdkClient.listSourceRepositories(request), true, { items: [] })
        const collection = pageableToCollection(requester, request, 'nextToken', 'items')
        return collection.map(
            summaries =>
                summaries?.map(s => ({
                    type: 'repo',
                    id: '',
                    org: { name: request.organizationName },
                    project: { name: request.projectName },
                    name: s.name ?? 'unknown',
                    ...s,
                })) ?? []
        )
    }

    /**
     * Lists ALL of the given resource in the current account
     */
    public listResources(resourceType: 'org'): AsyncCollection<CawsOrg[]>
    public listResources(resourceType: 'project'): AsyncCollection<CawsProject[]>
    public listResources(resourceType: 'repo'): AsyncCollection<CawsRepo[]>
    public listResources(resourceType: 'env'): AsyncCollection<DevelopmentWorkspace[]>
    public listResources(resourceType: CawsResource['type']): AsyncCollection<CawsResource[]> {
        // Don't really want to expose this apart of the `AsyncCollection` API yet
        // The semantics of concatenating async iterables is rather ambiguous
        // For example, an array of async iterables can be joined either in-order or out-of-order.
        // In-order concatenations only makes sense for finite iterables, though I'm unaware of any
        // convention to declare an iterable to be finite.
        function mapInner<T, U>(
            collection: AsyncCollection<T[]>,
            fn: (element: T) => AsyncCollection<U[]>
        ): AsyncCollection<U[]> {
            return toCollection(async function* () {
                for await (const element of await collection.promise()) {
                    yield* await Promise.all(element.map(e => fn(e).flatten().promise()))
                }
            })
        }

        switch (resourceType) {
            case 'org':
                return this.listOrgs()
            case 'project':
                return mapInner(this.listResources('org'), o => this.listProjects({ organizationName: o.name }))
            case 'repo':
                return mapInner(this.listResources('project'), p =>
                    this.listRepos({ projectName: p.name, organizationName: p.org.name })
                )
            case 'branch':
                throw new Error('Listing branches is not currently supported')
            case 'env':
                return mapInner(this.listResources('project'), p => this.listDevEnvs(p))
        }
    }

    /** CAWS */
    public async createDevEnv(args: caws.CreateDevelopmentWorkspaceRequest): Promise<DevelopmentWorkspace> {
        if (!args.ideRuntimes || args.ideRuntimes.length === 0) {
            throw new Error('missing ideRuntimes')
        }
        const r = await this.call(this.sdkClient.createDevelopmentWorkspace(args), false)
        assertHasProps(r, 'id')

        return this.getDevelopmentWorkspace({
            id: r.id,
            organizationName: args.organizationName,
            projectName: args.projectName,
        })
    }

    public async startDevEnv(
        args: caws.StartDevelopmentWorkspaceRequest
    ): Promise<caws.StartDevelopmentWorkspaceResponse | undefined> {
        const r = await this.call(this.sdkClient.startDevelopmentWorkspace(args), false)
        return r
    }

    public async startDevEnvSession(
        args: caws.StartSessionDevelopmentWorkspaceRequest
    ): Promise<caws.StartSessionDevelopmentWorkspaceResponse & { sessionId: string }> {
        const r = await this.call(this.sdkClient.startSessionDevelopmentWorkspace(args), false)
        if (!r.sessionId) {
            throw new TypeError('Received falsy CAWS workspace "sessionId"')
        }
        return { ...r, sessionId: r.sessionId }
    }

    public async stopDevEnv(
        args: caws.StopDevelopmentWorkspaceRequest
    ): Promise<caws.StopDevelopmentWorkspaceResponse> {
        return this.call(this.sdkClient.stopDevelopmentWorkspace(args), false)
    }

    public async getDevelopmentWorkspace(args: caws.GetDevelopmentWorkspaceRequest): Promise<DevelopmentWorkspace> {
        const a = { ...args }
        delete (a as any).ideRuntimes
        delete (a as any).repositories
        const r = await this.call(this.sdkClient.getDevelopmentWorkspace(a), false)

        return intoDevelopmentWorkspace(args.organizationName, args.projectName, { ...args, ...r })
    }

    public async deleteDevEnv(
        args: caws.DeleteDevelopmentWorkspaceRequest
    ): Promise<caws.DeleteDevelopmentWorkspaceResponse | undefined> {
        const r = await this.call(this.sdkClient.deleteDevelopmentWorkspace(args), false)
        return r
    }

    public updateDevelopmentWorkspace(
        args: caws.UpdateDevelopmentWorkspaceRequest
    ): Promise<caws.UpdateDevelopmentWorkspaceResponse> {
        return this.call(this.sdkClient.updateDevelopmentWorkspace(args), false)
    }

    /**
     * Best-effort attempt to start a workspace given an ID, showing a progress notifcation with a cancel button
     * TODO: may combine this progress stuff into some larger construct
     *
     * The cancel button does not abort the start, but rather alerts any callers that any operations that rely
     * on the CAWS workspace starting should not progress.
     *
     * @returns the environment on success, undefined otherwise
     */
    public async startEnvironmentWithProgress(
        args: caws.StartDevelopmentWorkspaceRequest,
        status: string,
        timeout: Timeout = new Timeout(180000)
    ): Promise<DevelopmentWorkspace | undefined> {
        let lastStatus: undefined | string
        try {
            const env = await this.getDevelopmentWorkspace(args)
            lastStatus = env?.status
            if (status === 'RUNNING' && lastStatus === 'RUNNING') {
                // "Debounce" in case caller did not check if the environment was already running.
                return env
            }
        } catch {
            lastStatus = undefined
        }

        const progress = await showMessageWithCancel(localize('AWS.caws.startMde.message', 'CODE.AWS'), timeout)
        progress.report({ message: localize('AWS.caws.startMde.checking', 'checking status...') })

        const pollMde = waitUntil(
            async () => {
                // technically this will continue to be called until it reaches its own timeout, need a better way to 'cancel' a `waitUntil`
                if (timeout.completed) {
                    return
                }

                const resp = await this.getDevelopmentWorkspace(args)
                if (lastStatus === 'STARTING' && (resp?.status === 'STOPPED' || resp?.status === 'STOPPING')) {
                    throw Error('Evironment failed to start')
                }

                if (resp?.status === 'STOPPED') {
                    progress.report({ message: localize('AWS.caws.startMde.stopStart', 'resuming environment...') })
                    await this.startDevEnv(args)
                } else if (resp?.status === 'STOPPING') {
                    progress.report({
                        message: localize('AWS.caws.startMde.resuming', 'waiting for environment to stop...'),
                    })
                } else {
                    progress.report({
                        message: localize('AWS.caws.startMde.starting', 'waiting for environment...'),
                    })
                }

                lastStatus = resp?.status
                return resp?.status === 'RUNNING' ? resp : undefined
            },
            // note: the `waitUntil` will resolve prior to the real timeout if it is refreshed
            { interval: 5000, timeout: timeout.remainingTime, truthy: true }
        )

        return waitTimeout(pollMde, timeout, {
            onExpire: () => (
                vscode.window.showErrorMessage(
                    localize('AWS.caws.startFailed', 'Timeout waiting for workspace: {0}', args.id)
                ),
                undefined
            ),
            onCancel: () => undefined,
        })
    }
}
