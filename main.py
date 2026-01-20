from CLIENT.LLMClient import LLMClient
import asyncio
async def main():
  client=LLMClient()
  messages=[{
    "role":"user",
    "content":"Hello, how are you?"
  }]
  async for event in client.chat_completion(messages,True):
    print(event)

  print("Done")


asyncio.run(main())