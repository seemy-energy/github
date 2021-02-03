import * as self from './github'
import { Octokit } from '@octokit/rest'
import { createAppAuth } from '@octokit/auth-app'
import { formatPullRequest, formatIssue } from './formatter'
import { paginateRest } from '@octokit/plugin-paginate-rest'
import { throttling } from '@octokit/plugin-throttling'
import { retry } from '@octokit/plugin-retry'
import { Endpoints } from '@octokit/types'
import SQS from 'aws-sdk/clients/sqs'
import DynamoDB from 'aws-sdk/clients/dynamodb'

export function getAuthenticatedOctokit (installationId: number): Octokit {
  const MyOctokit = Octokit.plugin(paginateRest, throttling, retry)
  const octokit = new MyOctokit({
    authStrategy: createAppAuth,
    auth: {
      appId: process.env.appId,
      type: 'app',
      privateKey: process.env.privateKey,
      installationId: installationId,
    },
    throttle: {
      onRateLimit: (retryAfter, options) => {
        octokit.log.warn(`Request quota exhausted for request ${options.method} ${options.url}`)
        if (options.request.retryCount === 0) {
          octokit.log.info(`Retrying after ${retryAfter} seconds!`)
          return true
        }
      },
      onAbuseLimit: (retryAfter, options) => {
        octokit.log.error(`Abuse detected for request ${options.method} ${options.url}`)
      },
    },
  })
  return octokit
}

export interface sqsPullMessage {
  owner: string
  repo: string
  pull_number: number
  installation_id: number
}

export interface sqsIssueMessage {
  owner: string
  repo: string
  issue_number: number
  installation_id: number
}

export async function queryRepo (owner: string, repo: string, octokit: Octokit): Promise<void> {
  for await (const pulls of octokit.paginate.iterator(octokit.pulls.list, {
    owner: owner,
    repo: repo,
  })) {
    await Promise.all(pulls.data.map(self.pullListPRtoSQS))
  }
  for await (const issues of octokit.paginate.iterator(octokit.issues.list, {
    owner: owner,
    repo: repo,
  })) {
    await issues.data.map(self.issueListPRtoSQS)
  }
}

export async function issueListPRtoSQS (
  issue: Endpoints['GET /repos/{owner}/{repo}/issues']['response']['data'][0],
): Promise<SQS.SendMessageResult> {
  return sqsClient
    .sendMessage({
      MessageBody: JSON.stringify(<sqsIssueMessage>{
        owner: issue.repository_url.split('/').reverse()[0],
        issue_number: issue.number,
        repo: issue.repository_url.split('/').reverse()[1],
        installation_id: 1234,
      }),
      MessageDeduplicationId: issue.url,
      MessageGroupId: issue.repository_url,
      QueueUrl: process.env.ISSUE_QUEUE,
    })
    .promise()
}

export async function pullListPRtoSQS (
  pull: Endpoints['GET /repos/{owner}/{repo}/pulls']['response']['data'][0],
): Promise<SQS.SendMessageResult> {
  return sqsClient
    .sendMessage({
      MessageBody: JSON.stringify(<sqsPullMessage>{
        owner: pull.base.user.login,
        pull_number: pull.number,
        repo: pull.base.repo.url,
        installation_id: 1234,
      }),
      MessageDeduplicationId: pull.url,
      MessageGroupId: pull.base.repo.url,
      QueueUrl: process.env.PR_QUEUE,
    })
    .promise()
}

const config = {
  convertEmptyValues: true,
  ...(process.env.MOCK_DYNAMODB_ENDPOINT && {
    endpoint: process.env.MOCK_DYNAMODB_ENDPOINT,
    sslEnabled: false,
    region: 'local',
  }),
}

export const documentClient = new DynamoDB.DocumentClient(config)

export const sqsClient = new SQS()

const upsert_table = async (payload, table) =>
  documentClient
    .put({
      Item: payload,
      TableName: table,
    })
    .promise()

export async function ETLPullRequest (
  owner: string,
  repo: string,
  pull_number: number,
  octokit: Octokit,
): Promise<void> {
  const pull = await octokit.pull.get({ owner, repo, pull_number })
  const formatted = formatPullRequest(pull)
  await upsert_table(formatted, 'pull')
  return
}

export async function ETLIssue (owner: string, repo: string, issue_number: number, octokit: Octokit): Promise<void> {
  const issue = await octokit.issue.get({ owner, repo, issue_number })
  const formatted = formatIssue(issue)
  await upsert_table(formatted, 'issue')
  return
}
